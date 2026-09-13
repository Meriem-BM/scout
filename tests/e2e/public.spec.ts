import { expect, test } from "@playwright/test";

import { getCapabilityCatalog } from "@scout/domain";

test("supported examples preserve scope and stay editable before submission", async ({
  page,
}) => {
  await page.goto("/watches");

  const prompt = page.getByRole("textbox", {
    name: "Describe the onchain activity Scout should monitor",
  });

  for (const starter of getCapabilityCatalog().examples) {
    await page
      .getByRole("button", { name: starter.label, exact: false })
      .click();
    await expect(prompt).toHaveValue(starter.prompt);
    await expect(prompt).toBeFocused();
    await expect(page).toHaveURL(/\/watches$/);
  }

  await page
    .getByRole("button", { name: "Watch V4 liquidity removals" })
    .click();
  await expect(prompt).toHaveValue(/without an amount or USD threshold/);
  await expect(
    page.getByRole("button", { name: "Detect large liquidity removals" }),
  ).toHaveCount(0);
  await prompt.fill("My custom monitoring request");
  await page.reload();
  await expect(prompt).toHaveValue("My custom monitoring request");
});

test("public narrative connects intent, history and the application", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Tell Scout what matters onchain." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What can Scout watch today?" }),
  ).toBeVisible();

  const catalog = page.locator(".story-section > .capability-catalog");

  await expect(catalog.locator(".capability-card")).toHaveCount(
    getCapabilityCatalog().protocols.length,
  );

  const catalogBox = await catalog.boundingBox();
  const sectionBox = await catalog.locator("..").boundingBox();

  expect(catalogBox!.width).toBeGreaterThan(sectionBox!.width * 0.95);

  for (const card of await catalog.locator(".capability-card").all()) {
    expect((await card.boundingBox())!.width).toBeGreaterThan(220);
  }

  expect(
    await catalog
      .locator("img.protocol-mark")
      .evaluateAll((images) =>
        images.every(
          (image) =>
            (image as HTMLImageElement).complete &&
            (image as HTMLImageElement).naturalWidth > 0,
        ),
      ),
  ).toBe(true);
  await expect(page.locator(".narrative-flow .sketch-arrow")).toHaveCount(0);
  await page.getByRole("link", { name: "How it works", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/how-it-works$/);
  await expect(
    page.getByRole("heading", {
      name: "From your request to a live Watch",
    }),
  ).toBeVisible();

  for (const path of [
    "/docs",
    "/docs/capabilities",
    "/docs/substreams",
    "/docs/architecture",
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("navigation", { name: "Documentation" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }

  await page.getByRole("link", { name: "Launch app", exact: true }).click();
  await expect(page).toHaveURL(/\/watches$/);
  await expect(
    page.getByRole("heading", { name: "Describe what matters onchain." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Watch $250K+ Uniswap swaps" })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "Describe the onchain activity Scout should monitor",
    }),
  ).toHaveValue(/250K/);
});

test("landing preview is view-only", async ({ page }) => {
  await page.goto("/");

  const preview = page.getByRole("figure", {
    name: "Illustrative Scout product preview",
  });

  await expect(preview).toBeVisible();
  await expect(
    preview.locator("input, textarea, button, a, [tabindex]"),
  ).toHaveCount(0);
  await expect(
    preview.getByText("Illustrative flow", { exact: false }),
  ).toBeVisible();
});
