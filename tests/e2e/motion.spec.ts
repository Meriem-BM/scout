import { expect, test } from "@playwright/test";

test("reduced motion preserves dialog focus and disables transitions", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/watches");

  const trigger = page.getByRole("button", {
    name: "View monitoring capabilities",
  });

  await trigger.click();

  const dialog = page.getByRole("dialog");

  await expect(dialog).toBeVisible();

  const motion = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);

    return {
      animation: style.animationName,
      transition: style.transitionDuration,
    };
  });

  expect(motion).toEqual({ animation: "none", transition: "0s" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("closing a dialog preserves the draft and scroll position", async ({
  page,
}) => {
  await page.goto("/watches");

  const draft = page.getByLabel(
    "Describe the onchain activity Scout should monitor",
  );

  await draft.fill("Watch USDC transfers above $500K on Base.");

  const trigger = page.getByRole("button", {
    name: "View monitoring capabilities",
  });

  await trigger.scrollIntoViewIfNeeded();

  const scroll = await page.evaluate(() => window.scrollY);

  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(draft).toHaveValue("Watch USDC transfers above $500K on Base.");
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
});
