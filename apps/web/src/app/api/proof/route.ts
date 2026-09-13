import { z } from "zod";

import { admin, HttpError, identity } from "@/server/auth";
import { route } from "@/server/http";

export const GET = route(async (request) => {
  const params = new URL(request.url).searchParams;
  const id = z.string().uuid().parse(params.get("watch"));
  const file = z
    .enum(["package.spkg", "manifest.yaml", "build.log", "sources.json"])
    .nullable()
    .parse(params.get("file"));
  const { userId } = await identity();
  const { data, error } = await admin()
    .from("pipeline_deployments")
    .select("*")
    .eq("watch_id", id)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error || !data?.length) {
    throw new HttpError(404, "Pipeline proof is unavailable.");
  }

  if (!file) {
    return { deployments: data };
  }

  const hash = data[0]?.artifact_hash;

  if (!hash) {
    throw new HttpError(409, "The package is still being prepared.");
  }

  const download = await admin()
    .storage.from("pipeline-artifacts")
    .createSignedUrl(`${hash}/${file}`, 60);

  if (download.error) {
    throw new Error("Artifact download is unavailable.");
  }

  return { url: download.data.signedUrl };
});
