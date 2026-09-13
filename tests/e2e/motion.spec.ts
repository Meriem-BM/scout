import { expect, test } from "@playwright/test";

test("capability navigation respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/watches");
  await page.getByRole("link", { name: "What can Scout watch? →" }).click();
  await expect(
    page.getByRole("heading", { name: "Start with what’s available." }),
  ).toBeVisible();

  const link = page.getByRole("link", { name: "Understand capabilities →" });

  await link.focus();
  await expect(link).toBeFocused();

  const motion = await link.evaluate((element) => ({
    animation: getComputedStyle(element).animationName,
    transition: getComputedStyle(element).transitionDuration,
  }));

  expect(motion).toEqual({ animation: "none", transition: "0s" });
});

test("exploring capabilities preserves an unfinished request", async ({
  page,
}) => {
  await page.goto("/watches");

  const draft = page.getByLabel(
    "Describe the onchain activity Scout should monitor",
  );

  await draft.fill("Watch USDC transfers above $500K on Base.");
  await page.getByRole("link", { name: "What can Scout watch? →" }).click();
  await expect(
    page.getByRole("heading", { name: "Start with what’s available." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "← Your Watches" }).click();
  await expect(draft).toHaveValue("Watch USDC transfers above $500K on Base.");
});
