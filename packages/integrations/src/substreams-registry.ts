import { createSubstream } from "@substreams/core";
import { z } from "zod";

import {
  type DataRequirementSpec,
  type PackageCandidate,
  PackageCandidateSchema,
} from "@scout/domain";

import { assertServer, fetchJson, IntegrationError } from "./http";
import { matchOutputFields, outputFields } from "./package-descriptors";

const RegistryPackage = z.object({
  name: z.string(),
  slug: z.string(),
  organization: z
    .object({ name: z.string().optional(), slug: z.string().optional() })
    .nullable()
    .optional(),
  repository: z.string().default(""),
  downloads: z.number().int().nonnegative().default(0),
  releaseCount: z.number().int().nonnegative().default(0),
  latestVersion: z.string(),
  network: z.string().default(""),
  spkg: z.string(),
  reference: z.string(),
});
const SearchResponse = z.object({
  packages: z.array(RegistryPackage).default([]),
  hasMore: z.boolean().default(false),
  recommendations: z
    .array(
      z.object({
        package: RegistryPackage,
        reason: z.string(),
        term: z.string(),
      }),
    )
    .default([]),
});

const packageHost = new Set(["substreams.dev", "spkg.io"]);
const packageRedirectStatuses = new Set([301, 302, 303, 307, 308]);
const packageRedirectLimit = 3;

function validatedPackageUrl(value: string) {
  const url = new URL(value);

  if (
    url.protocol !== "https:" ||
    !packageHost.has(url.hostname) ||
    !!url.username ||
    !!url.password ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw new IntegrationError(
      "REGISTRY_URL",
      "The registry returned an untrusted package location.",
    );
  }

  return url;
}

export async function downloadPackage(urlValue: string, signal?: AbortSignal) {
  let url = validatedPackageUrl(urlValue);
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    : AbortSignal.timeout(20_000);
  let response: Response | null = null;
  let redirectCount = 0;

  while (true) {
    try {
      response = await fetch(url, {
        cache: "no-store",
        redirect: "manual",
        signal: requestSignal,
      });
    } catch {
      throw new IntegrationError(
        "PACKAGE_DOWNLOAD",
        "A package reference resolved, but its artifact could not be downloaded.",
        30,
      );
    }

    if (!packageRedirectStatuses.has(response.status)) {
      break;
    }

    const location = response.headers.get("location");

    if (!location || redirectCount >= packageRedirectLimit) {
      throw new IntegrationError(
        "PACKAGE_REDIRECT",
        "A package artifact returned an invalid redirect chain.",
      );
    }

    url = validatedPackageUrl(new URL(location, url).toString());
    redirectCount += 1;
  }

  if (!response.ok) {
    throw new IntegrationError(
      `PACKAGE_HTTP_${response.status}`,
      "A package reference did not resolve to a downloadable artifact.",
      response.status >= 500 ? 30 : null,
    );
  }

  const declared = Number(response.headers.get("content-length") ?? 0);

  if (declared > 25_000_000) {
    throw new IntegrationError(
      "PACKAGE_SIZE",
      "The discovered package exceeds Scout's inspection limit.",
    );
  }

  const reader = response.body?.getReader();

  if (!reader) {
    throw new IntegrationError(
      "PACKAGE_DOWNLOAD",
      "Package response has no body.",
    );
  }

  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      length += chunk.value.byteLength;

      if (length > 25_000_000) {
        await reader.cancel();

        throw new IntegrationError(
          "PACKAGE_SIZE",
          "The package exceeds Scout's inspection limit.",
        );
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (bytes.length < 100 || bytes.length > 25_000_000) {
    throw new IntegrationError(
      "PACKAGE_SIZE",
      "The discovered package has an invalid artifact size.",
    );
  }

  return bytes;
}

function normalizeRequirement(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function packageText(
  item: z.infer<typeof RegistryPackage>,
  pkg: ReturnType<typeof createSubstream>,
) {
  return normalizeRequirement(
    [
      item.name,
      item.slug,
      item.reference,
      item.repository,
      ...pkg.packageMeta.flatMap((meta) => [meta.name, meta.doc, meta.url]),
      ...(pkg.modules?.modules ?? []).map((module) => module.name),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export function scorePackageCandidate(input: {
  matched: number;
  required: number;
  networkCompatible: boolean;
  protocolCompatible: boolean;
  trustedPublisher: boolean;
  sourceAvailable: boolean;
  downloads: number;
}) {
  const coverage = input.required ? input.matched / input.required : 0;

  return Math.round(
    coverage * 55 +
      (input.networkCompatible ? 18 : -50) +
      (input.protocolCompatible ? 15 : -25) +
      (input.trustedPublisher ? 7 : 0) +
      (input.sourceAvailable ? 3 : 0) +
      Math.min(2, Math.log10(input.downloads + 1)),
  );
}

function inspect(
  item: z.infer<typeof RegistryPackage>,
  bytes: Uint8Array,
  requirements: DataRequirementSpec,
): PackageCandidate {
  let pkg: ReturnType<typeof createSubstream>;

  try {
    pkg = createSubstream(bytes);
  } catch {
    throw new IntegrationError(
      "PACKAGE_INVALID",
      `${item.reference} is not a readable Substreams package.`,
    );
  }

  const wanted = [
    ...new Set(requirements.requiredStreams.flatMap((stream) => stream.fields)),
  ];
  const rawModules = pkg.modules?.modules ?? [];
  const moduleMap = new Map(rawModules.map((module) => [module.name, module]));

  const graphValid = (name: string, ancestors = new Set<string>()): boolean => {
    const entry = moduleMap.get(name);

    if (!entry || ancestors.has(name) || ancestors.size > 100) {
      return false;
    }

    const path = new Set([...ancestors, name]);

    return (
      entry.inputs.every((input) => {
        if (input.input.case === "map" || input.input.case === "store") {
          return graphValid(input.input.value.moduleName, path);
        }

        return input.input.case === "source" || input.input.case === "params";
      }) &&
      (!entry.blockFilter || graphValid(entry.blockFilter.module, path))
    );
  };

  const inspectedModules = rawModules.map((module) => {
    const fields = outputFields(pkg.protoFiles, module.output?.type ?? "");
    const dependencyGraphValid = graphValid(module.name);

    return {
      name: module.name,
      kind:
        module.kind.case === "kindStore"
          ? "store"
          : module.kind.case === "kindBlockIndex"
            ? "blockIndex"
            : "map",
      outputType: module.output?.type ?? null,
      initialBlock: module.initialBlock?.toString() ?? null,
      outputFields: fields,
      matchingFields: matchOutputFields(wanted, fields),
      dependencyGraphValid,
    };
  });
  const bestModule = inspectedModules
    .filter((module) => module.kind === "map" && module.dependencyGraphValid)
    .sort((a, b) => b.matchingFields.length - a.matchingFields.length)[0];
  const matchingFields = bestModule?.matchingFields ?? [];
  const missingFields = wanted.filter(
    (field) => !matchingFields.includes(field),
  );
  const searchablePackage = packageText(item, pkg);
  const protocolCompatible = requirements.packageHints.compatibilityTerms.some(
    (term) => searchablePackage.includes(normalizeRequirement(term)),
  );
  const effectiveNetwork = pkg.network || item.network;
  const ethereumFoundation =
    (!effectiveNetwork ||
      effectiveNetwork === "mainnet" ||
      effectiveNetwork === "ethereum") &&
    requirements.chain === "ethereum" &&
    /ethereum[_-]?common/i.test(
      `${item.name} ${item.slug} ${item.reference}`,
    ) &&
    (pkg.modules?.modules ?? []).some(
      (module) =>
        module.name.endsWith("index_events") &&
        module.output?.type === "proto:sf.substreams.index.v1.Keys",
    );
  const networkCompatible =
    (requirements.chain === "base" &&
      item.reference === "ethereum-common@v0.3.3" &&
      (pkg.modules?.modules ?? []).some(
        (module) =>
          module.name === "filtered_events" &&
          module.output?.type === "proto:sf.substreams.ethereum.v1.Events",
      )) ||
    effectiveNetwork === requirements.chain ||
    (requirements.chain === "ethereum" && effectiveNetwork === "mainnet") ||
    ethereumFoundation;
  const modules = pkg.modules?.modules ?? [];
  const source =
    pkg.packageMeta
      .map((meta) => meta.url)
      .find((value) => value?.startsWith("https://")) ?? null;
  const dependencies = [
    ...new Set(
      pkg.packageMeta.slice(1).map((meta) => `${meta.name}@${meta.version}`),
    ),
  ];
  const outputs = modules.flatMap((module) =>
    module.output?.type ? [module.output.type] : [],
  );
  const score = scorePackageCandidate({
    matched: matchingFields.length,
    required: wanted.length,
    networkCompatible,
    protocolCompatible,
    trustedPublisher:
      item.organization?.slug === "streamingfast" ||
      /streamingfast/i.test(item.repository),
    sourceAvailable: !!source,
    downloads: item.downloads,
  });

  return PackageCandidateSchema.parse({
    ref: item.reference,
    name: item.name,
    version: item.latestVersion,
    network: effectiveNetwork || null,
    publisher: item.organization?.slug ?? item.organization?.name ?? null,
    modules: inspectedModules,
    outputs: [...new Set(outputs)],
    parameters: modules
      .filter((module) =>
        module.inputs.some((input) => input.input.case === "params"),
      )
      .map((module) => module.name),
    dependencies,
    registryUrl:
      /^[a-z0-9-]+$/.test(item.slug) &&
      /^v[0-9][a-zA-Z0-9.-]*$/.test(item.latestVersion)
        ? `https://substreams.dev/packages/${item.slug}/${item.latestVersion}`
        : null,
    packageUrl: item.spkg,
    sourceUrl: source,
    evidence: {
      matchingFields,
      missingFields,
      networkCompatible,
      protocolCompatible,
      packageResolved: true,
    },
    trustSignals: {
      publisher: item.organization?.slug ?? item.organization?.name ?? null,
      downloads: item.downloads,
      freshness: item.latestVersion,
      sourceAvailable: !!source,
    },
    score,
  });
}

export class SubstreamsRegistry {
  constructor(private readonly baseUrl = "https://substreams.dev/v1/registry") {
    assertServer();

    const url = new URL(baseUrl);

    if (url.protocol !== "https:" || url.hostname !== "substreams.dev") {
      throw new Error("Invalid Substreams registry URL.");
    }
  }

  async discover(requirements: DataRequirementSpec, signal?: AbortSignal) {
    const fallback = ["ethereum", "base"].includes(requirements.chain)
      ? "ethereum common"
      : `${requirements.chain} common`;
    const hintedQueries = requirements.packageHints.queries
      .map((value) => ({
        value,
        filterNetwork: true,
      }))
      .filter(
        (entry, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.value.toLowerCase() === entry.value.toLowerCase(),
          ) === index,
      )
      .slice(0, 7);
    const queries = [
      ...hintedQueries,
      ...(hintedQueries.some(
        (entry) => entry.value.toLowerCase() === fallback.toLowerCase(),
      )
        ? []
        : [{ value: fallback, filterNetwork: false }]),
    ];
    const query = queries.map((entry) => entry.value).join(" · ");
    const searched = await Promise.allSettled(
      queries.map(async (entry) => {
        const url = new URL(`${this.baseUrl}/packages`);

        url.searchParams.set("query", entry.value);

        if (entry.filterNetwork) {
          url.searchParams.set(
            "network",
            requirements.chain === "ethereum" ? "mainnet" : requirements.chain,
          );
        }

        url.searchParams.set("pageSize", "12");

        return SearchResponse.parse(
          await fetchJson(url.toString(), { signal }, 15_000),
        );
      }),
    );
    const results = searched.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const failures = searched.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            `${queries[index]?.value ?? "package search"}: ${result.reason instanceof Error ? result.reason.message : "search failed"}`,
          ]
        : [],
    );

    if (!results.length) {
      throw new IntegrationError(
        "REGISTRY_SEARCH",
        "Every Substreams registry query failed for this data requirement.",
        60,
      );
    }

    const ordered = results.flatMap((found) => [
      ...found.recommendations.map((entry) => entry.package),
      ...found.packages,
    ]);
    const deduplicated = [
      ...new Map(
        ordered
          .filter((item) => item.reference && item.spkg)
          .map((item) => [item.reference, item]),
      ).values(),
    ];
    const pinnedFoundation = deduplicated.find(
      (item) => item.reference === "ethereum-common@v0.3.3",
    );
    const unique = [
      ...(pinnedFoundation ? [pinnedFoundation] : []),
      ...deduplicated.filter(
        (item) => item.reference !== pinnedFoundation?.reference,
      ),
    ].slice(0, 6);

    if (!unique.length) {
      throw new IntegrationError(
        "REGISTRY_EMPTY",
        "The Substreams registry returned no package candidates for this data requirement.",
        60,
      );
    }

    const packageResults = await Promise.allSettled(
      unique.map(async (item) => ({
        candidate: inspect(
          item,
          await downloadPackage(item.spkg, signal),
          requirements,
        ),
        ref: item.reference,
      })),
    );
    const inspected = packageResults.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.candidate] : [],
    );

    packageResults.forEach((result, index) => {
      if (result.status === "rejected") {
        failures.push(
          `${unique[index]?.reference ?? "package"}: ${result.reason instanceof Error ? result.reason.message : "inspection failed"}`,
        );
      }
    });

    if (!inspected.length) {
      const detail = failures.slice(0, 3).join(" ").slice(0, 1_000);

      throw new IntegrationError(
        "PACKAGE_INSPECTION",
        `Registry candidates were found, but none passed package inspection.${detail ? ` ${detail}` : ""}`,
        60,
      );
    }

    return {
      query,
      candidates: inspected.sort((a, b) => b.score - a.score),
      failures,
    };
  }
}
