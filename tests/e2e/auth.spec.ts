import { expect, test } from "@playwright/test";

test("extension attributes on the root element do not report a hydration mismatch", async ({
  page,
}) => {
  const hydrationErrors: string[] = [];

  page.on("console", (message) => {
    const text = message.text();

    if (
      message.type() === "error" &&
      /hydration|server rendered html|did not match/i.test(text)
    ) {
      hydrationErrors.push(text);
    }
  });

  await page.addInitScript(() => {
    document.documentElement.setAttribute("data-darkreader-mode", "dynamic");
    document.documentElement.setAttribute("data-darkreader-scheme", "dark");
    document.documentElement.setAttribute(
      "data-darkreader-proxy-injected",
      "true",
    );
    document.documentElement.style.colorScheme = "dark";
  });
  await page.goto("/watches");
  await expect(
    page.getByRole("heading", { name: "Describe what matters onchain." }),
  ).toBeVisible();
  await page.waitForFunction(() => document.readyState === "complete");
  await page.getByRole("link", { name: "What can Scout watch? →" }).click();
  await expect(
    page.getByRole("heading", { name: "Start with what’s available." }),
  ).toBeVisible();

  expect(hydrationErrors).toEqual([]);
});

test("anonymous draft stays in context while sign-in opens from the watch flow", async ({
  page,
}) => {
  await page.goto("/watches");

  await expect(
    page.getByRole("heading", { name: "Describe what matters onchain." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "What can Scout watch? →" }).click();
  await expect(
    page.getByRole("heading", { name: "Start with what’s available." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Uniswap V3 swaps", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Native USDC transfers", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "← Your Watches" }).click();

  const draft =
    "Watch wallet 0x1111111111111111111111111111111111111111 for transfers above $250K.";

  await page
    .getByLabel("Describe the onchain activity Scout should monitor")
    .fill(draft);
  await expect(page.getByRole("link", { name: "Scout home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();

  const viewport = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollX: window.scrollX,
  }));

  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.innerWidth);
  expect(viewport.scrollX).toBe(0);
  await page.screenshot({
    path: `docs/screenshots/protocol-home-${test.info().project.name}.png`,
    fullPage: true,
    caret: "initial",
  });
  await page
    .getByRole("button", { name: "Create monitor", exact: true })
    .click();
  await expect(page).toHaveURL(/\/watches(?:\?.*)?$/);
  await expect(page.getByText("Already used Scout?")).toHaveCount(0);

  const modal = page.getByRole("heading", { name: "Log in or sign up" });
  const modalOpened = await expect(modal)
    .toBeVisible({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (modalOpened) {
    await expect(page.getByPlaceholder("your@email.com")).toBeVisible();
    await expect(
      page.getByText("Continue with a wallet", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `docs/screenshots/privy-modal-${test.info().project.name}.png`,
      fullPage: true,
      caret: "initial",
    });
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  }

  await page.reload();
  await expect(
    page.getByLabel("Describe the onchain activity Scout should monitor"),
  ).toHaveValue(draft);
});

test("watch-scoped incident links retain their destination", async ({
  page,
  request,
}) => {
  const watch = "11111111-1111-4111-8111-111111111111";
  const incident = "22222222-2222-4222-8222-222222222222";
  const destination = `/watches/${watch}/incidents/${incident}`;

  await page.goto(destination);
  await expect(page).toHaveURL(destination);

  const signIn = page.getByRole("button", {
    name: "Sign in to continue",
    exact: true,
  });

  await expect(signIn).toBeVisible();

  const canOpenPrivy = await expect(signIn)
    .toBeEnabled({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (canOpenPrivy) {
    await signIn.click();
    await expect(
      page.getByRole("heading", { name: "Log in or sign up" }),
    ).toBeVisible();
    await expect(page).toHaveURL(destination);
    await page.keyboard.press("Escape");
  } else {
    await expect(signIn).toBeDisabled();
  }

  for (const path of [
    "/api/state",
    "/api/watches",
    "/api/connections",
    "/api/trades",
  ]) {
    expect((await request.get(path)).status()).toBe(401);
  }

  for (const path of [
    "/signin",
    "/inbox",
    `/incidents/${incident}`,
    "/auth/confirm",
    "/api/auth/link",
  ]) {
    expect((await request.get(path)).status()).toBe(404);
  }
});
