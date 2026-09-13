import { expect, test } from "@playwright/test";

import { getCapabilityCatalog } from "@scout/domain";

test("explorer exposes real scope and unavailable liquidity value", async ({
  page,
  request,
}) => {
  const response = await request.get("/api/capabilities");

  expect(response.ok()).toBe(true);
  expect(response.headers()["cache-control"]).toContain("no-cache");

  const catalog = getCapabilityCatalog();

  expect(await response.json()).toEqual(catalog);
  await page.goto("/capabilities");

  for (const entry of catalog.protocols) {
    await expect(
      page.getByRole("heading", { name: entry.title, exact: true }),
    ).toBeVisible();
  }

  const liquidity = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Uniswap V4 liquidity changes" }),
  });

  await liquidity.getByText("What Scout can use", { exact: true }).click();

  const value = liquidity
    .locator("li")
    .filter({ hasText: "USD value of removed liquidity" });

  await expect(value).toContainText("Not available yet");
  await liquidity.getByText("Scope & limitations", { exact: true }).click();
  await expect(
    liquidity.getByText("Scout can read liquidity changes", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("backend status changes propagate to landing, docs, explorer and examples", async ({
  page,
}) => {
  const catalog = getCapabilityCatalog();

  catalog.protocols = catalog.protocols.map((p) => ({
    ...p,
    status: "VERIFIED",
  }));
  catalog.examples = [];
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ json: catalog }),
  );

  for (const url of ["/", "/docs/capabilities", "/capabilities"]) {
    await page.goto(url);
    await expect(
      page
        .locator(".capability-card-meta .capability-status")
        .filter({ hasText: "Ready" }),
    ).toHaveCount(catalog.protocols.length);
    await expect(
      page.getByRole("link", {
        name: "Watch V4 liquidity removals",
        exact: true,
      }),
    ).toHaveCount(0);
  }

  await page.goto("/watches");
  await expect(
    page.getByRole("heading", { name: "Describe what matters onchain." }),
  ).toBeVisible();
  await expect(page.locator(".example-row button")).toHaveCount(0);
});
