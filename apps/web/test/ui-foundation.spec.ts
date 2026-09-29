import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const appRoot = resolve(repoRoot, "apps/web");
const browserRoot = resolve(repoRoot, "apps/web/dist/browser");
const productionPort = Number(process.env.WEB_FOUNDATION_PORT ?? "4173");
const fixturePort = Number(process.env.WEB_FOUNDATION_FIXTURE_PORT ?? String(productionPort + 1));
const fixturePath = "/test/ui-foundation.fixture.html";
const fontRoot = resolve(repoRoot, "packages/platform-ui/src/styles/fonts");

async function assertFontSourceIdentity(): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(fontRoot, "prototype-font-manifest.json"), "utf8")) as {
    prototypeCommit: string;
    sourceFiles: Record<string, string>;
    fontFiles: Array<{ file: string; sha256: string; bytes: number }>;
  };
  assert.equal(manifest.prototypeCommit, "2aa6644c9c042c7b722702e6cde31324a4057bb9");
  const tokens = await readFile(resolve(repoRoot, "packages/platform-ui/src/styles/tokens.css"));
  const globalStyles = await readFile(resolve(repoRoot, "packages/platform-ui/src/styles/global.css"));
  assert.equal(createHash("sha256").update(tokens).digest("hex"), manifest.sourceFiles["app/styles/tokens.css"]);
  assert.equal(createHash("sha256").update(globalStyles).digest("hex"), manifest.sourceFiles["app/styles/global.css"]);
  assert.equal(manifest.fontFiles.length, 13);
  for (const font of manifest.fontFiles) {
    const path = resolve(fontRoot, font.file);
    const data = await readFile(path);
    assert.equal(data.byteLength, font.bytes, `${font.file} byte size drift`);
    assert.equal(createHash("sha256").update(data).digest("hex"), font.sha256, `${font.file} SHA-256 drift`);
  }
  const assets = await import("node:fs/promises").then(({ readdir }) => readdir(fontRoot));
  assert.deepEqual(assets.filter((file) => file.endsWith(".woff2")).sort(), manifest.fontFiles.map(({ file }) => file).sort());
  assert.ok((await stat(resolve(fontRoot, "Inter-OFL.txt"))).size > 0);
  assert.ok((await stat(resolve(fontRoot, "Manrope-OFL.txt"))).size > 0);
}

type PageSignals = {
  consoleErrors: string[];
  externalRequests: string[];
  failedResponses: string[];
  fontRequests: string[];
};

function observePage(page: Page): PageSignals {
  const signals: PageSignals = {
    consoleErrors: [],
    externalRequests: [],
    failedResponses: [],
    fontRequests: [],
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") signals.externalRequests.push(request.url());
    if (url.pathname.endsWith(".woff2")) signals.fontRequests.push(request.url());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) signals.failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") signals.consoleErrors.push(message.text());
  });
  return signals;
}

async function startPreviewServer(root: string, port: number, configFile: string | false, healthPath = "/"): Promise<PreviewServer> {
  const server = await preview({
    configFile,
    preview: { host: "127.0.0.1", port, strictPort: true },
    root,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}${healthPath}`);
    if (!response.ok) throw new Error(`Vite preview returned HTTP ${response.status}`);
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function buildFixture(outDir: string): Promise<void> {
  await build({
    configFile: false,
    root: appRoot,
    plugins: [tailwindcss()],
    mode: "test",
    build: {
      emptyOutDir: true,
      outDir: relative(appRoot, outDir),
      rollupOptions: {
        input: resolve(appRoot, "test/ui-foundation.fixture.html"),
      },
    },
  });
}

async function assertNoCriticalA11y(page: Page, state: string): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const violations = result.violations.filter((violation) =>
    violation.impact === "serious" || violation.impact === "critical",
  );
  assert.deepEqual(
    violations,
    [],
    `${state} has serious/critical accessibility violations: ${JSON.stringify(violations)}`,
  );
}

async function assertNoOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(
    dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `${width}px layout overflows: ${JSON.stringify(dimensions)}`,
  );
}

async function assertFoundationTokens(page: Page): Promise<void> {
  const tokens = await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('[data-slot="button"]');
    if (!button) throw new Error("foundation button is missing");
    const rootStyles = getComputedStyle(document.documentElement);
    const bodyStyles = getComputedStyle(document.body);
    const buttonStyles = getComputedStyle(button);
    return {
      bodyFontSize: bodyStyles.fontSize,
      buttonFontSize: buttonStyles.fontSize,
      buttonRadius: buttonStyles.borderRadius,
      rootFontSize: rootStyles.fontSize,
    };
  });
  assert.equal(tokens.rootFontSize, "16px", `unexpected root rem baseline: ${JSON.stringify(tokens)}`);
  assert.equal(tokens.bodyFontSize, "14px", `unexpected body typography: ${JSON.stringify(tokens)}`);
  assert.equal(tokens.buttonFontSize, "14px", `unexpected standard button typography: ${JSON.stringify(tokens)}`);
  assert.equal(tokens.buttonRadius, "8px", `unexpected control radius: ${JSON.stringify(tokens)}`);
}

function assertPageSignals(signals: PageSignals, label: string): void {
  assert.deepEqual(signals.externalRequests, [], `${label} made an external request`);
  assert.deepEqual(signals.failedResponses, [], `${label} returned failed HTTP responses: ${signals.failedResponses.join(" | ")}`);
  assert.deepEqual(signals.consoleErrors, [], `${label} console errors: ${signals.consoleErrors.join(" | ")}`);
}

async function testProductionShell(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  const signals = observePage(page);
  await page.route("**/auth/session", (route) => route.fulfill({
    body: JSON.stringify({ actorRef: "operator-foundation", expiresAt: "2026-09-29T12:00:00.000Z" }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route("**/api/client-v1/customers**", (route) => route.fulfill({
    body: JSON.stringify({ items: [], nextCursor: null }),
    contentType: "application/json",
    status: 200,
  }));
  await page.goto(`http://127.0.0.1:${productionPort}/`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Клиенты" }).waitFor();
  assert.equal(await page.title(), "CoffeeOrderPlatform — Оператор");
  assert.equal(await page.getByText("Счета").count(), 0, "invoice registry fixture leaked into production shell");
  assert.equal(await page.getByRole("link", { name: "Клиенты" }).first().getAttribute("aria-current"), "page");
  assert.equal(await page.getByRole("link", { name: "Каталог" }).count(), 1);
  await assertNoCriticalA11y(page, "production operator shell");
  await assertFoundationTokens(page);

  const fontState = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      bodyFamily: getComputedStyle(document.body).fontFamily,
      headingFamily: getComputedStyle(document.querySelector("h1")!).fontFamily,
      loadedInter: document.fonts.check('16px "Inter Variable"'),
      loadedManrope: document.fonts.check('16px "Manrope Variable"'),
    };
  });
  assert.match(fontState.bodyFamily, /Inter Variable/);
  assert.match(fontState.headingFamily, /Manrope Variable/);
  assert.equal(fontState.loadedInter, true, "Inter variable face did not load");
  assert.equal(fontState.loadedManrope, true, "Manrope variable face did not load");
  assert.ok(signals.fontRequests.length >= 2, "production shell did not request both local variable font families");
  await page.setViewportSize({ width: 1024, height: 600 });
  const desktopSidebar = await page.locator(".operator-sidebar").boundingBox();
  assert.ok(desktopSidebar && Math.abs(desktopSidebar.width - 226) <= 1, `1024px desktop sidebar is missing or not 226px: ${JSON.stringify(desktopSidebar)}`);
  await page.setViewportSize({ width: 1023, height: 600 });
  assert.equal(await page.locator(".operator-sidebar").isVisible(), false, "below 1024px desktop boundary the sidebar should be hidden");
  assert.equal(await page.locator(".mobile-nav").isVisible(), true, "mobile navigation is missing below the desktop boundary");
  for (const width of [375, 768, 1280]) await assertNoOverflow(page, width);
  assertPageSignals(signals, "production shell");
  await page.close();
}

async function testScenarioFixture(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  const signals = observePage(page);
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto(`http://127.0.0.1:${fixturePort}${fixturePath}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Проверяемая browser surface CoffeeOrderPlatform" }).waitFor();
  await assertNoCriticalA11y(page, "fixture initial foundation");
  await assertFoundationTokens(page);
  const fontState = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      hasFamily: getComputedStyle(document.body).fontFamily.includes("Inter Variable"),
      loadedRegular: document.fonts.check('16px "Inter Variable"'),
    };
  });
  assert.equal(fontState.hasFamily, true, "fixture did not activate Inter");
  assert.equal(fontState.loadedRegular, true, "fixture Inter variable face did not load");
  assert.ok(signals.fontRequests.length >= 1, "fixture did not request a local WOFF2 font");

  const invalidField = page.getByRole("textbox", { name: "Email оператора" });
  const disabledField = page.getByRole("textbox", { name: "Disabled field" });
  assert.equal(await disabledField.isDisabled(), true);
  await page.getByRole("button", { name: "Фокусировать первое invalid поле" }).click();
  assert.equal(await invalidField.getAttribute("aria-invalid"), "true");
  assert.equal(await invalidField.evaluate((element) => document.activeElement === element), true);
  await assertNoCriticalA11y(page, "fixture invalid and disabled fields");

  const trigger = page.getByRole("button", { name: "Открыть диалог" });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Foundation dialog test fixture" });
  await dialog.waitFor();
  const dialogInput = dialog.getByRole("textbox", { name: "Данные dialog" });
  assert.equal(await dialogInput.evaluate((element) => document.activeElement === element), true);
  const dialogSurface = await dialog.evaluate((element) => {
    const surface = element.parentElement;
    if (!surface) return { clientHeight: 0, maxHeight: "none", overflowY: "visible", scrollHeight: 0 };
    const styles = getComputedStyle(surface);
    return { clientHeight: surface.clientHeight, maxHeight: styles.maxHeight, overflowY: styles.overflowY, scrollHeight: surface.scrollHeight };
  });
  assert.notEqual(dialogSurface.maxHeight, "none");
  assert.equal(dialogSurface.overflowY, "auto");
  assert.ok(dialogSurface.scrollHeight > dialogSurface.clientHeight, `long dialog did not scroll: ${JSON.stringify(dialogSurface)}`);
  await assertNoCriticalA11y(page, "fixture open dialog");

  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await dialog.waitFor({ state: "hidden" });
  await trigger.click();
  await dialog.waitFor();
  const outsideCloseRequests = Number(await page.getByTestId("outside-close-requests").textContent());
  await page.mouse.click(2, 2);
  await dialog.waitFor({ state: "hidden" });
  assert.equal(Number(await page.getByTestId("outside-close-requests").textContent()), outsideCloseRequests + 1, "allowed outside interaction must check the close policy once");
  await trigger.click();
  await dialog.waitFor();
  await dialogInput.fill("изменено");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true, "dirty dialog closed on Escape after reopen");
  await page.mouse.click(2, 2);
  assert.equal(await dialog.isVisible(), true, "dirty dialog closed on outside interaction");
  assert.equal(await dialogInput.getAttribute("aria-invalid"), "true");
  await assertNoCriticalA11y(page, "fixture dirty dialog after reopen");
  await dialog.getByRole("button", { name: "Сбросить изменения" }).click();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await trigger.click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Включить pending" }).click();
  assert.equal(await dialog.getByRole("button", { name: "Операция выполняется" }).getAttribute("aria-disabled"), "true");
  await assertNoCriticalA11y(page, "fixture pending dialog");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true, "pending dialog closed on Escape");
  await dialog.getByRole("button", { name: "Снять pending" }).click();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await page.emulateMedia({ reducedMotion: "reduce" });
  const transitionDuration = await trigger.evaluate((element) => getComputedStyle(element).transitionDuration);
  assert.equal(transitionDuration, "1e-05s", "reduced-motion transition is not disabled");
  for (const width of [375, 768, 1280]) await assertNoOverflow(page, width);
  for (const [name, minimumHeight] of [["Малая 36", 36], ["Средняя 40", 40], ["Большая 44", 44]] as const) {
    const targetSize = await page.getByRole("button", { name }).boundingBox();
    assert.ok(targetSize && targetSize.height >= minimumHeight, `${name} target is too small: ${JSON.stringify(targetSize)}`);
  }
  assertPageSignals(signals, "scenario fixture");
  await page.close();
}

async function main(): Promise<void> {
  await assertFontSourceIdentity();
  await readFile(resolve(browserRoot, "index.html"));
  const productionServer = await startPreviewServer(browserRoot, productionPort, resolve(appRoot, "vite.config.ts"));
  const fixtureRoot = await mkdtemp(join(appRoot, ".tmp-ui-foundation-fixture-"));
  const fixtureDist = resolve(fixtureRoot, "dist");
  let fixtureServer: PreviewServer | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    await buildFixture(fixtureDist);
    await readFile(resolve(fixtureDist, fixturePath.slice(1)));
    fixtureServer = await startPreviewServer(fixtureRoot, fixturePort, false, fixturePath);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await testProductionShell(context);
    await testScenarioFixture(context);
  } finally {
    await context?.close();
    await browser?.close();
    await fixtureServer?.close();
    await productionServer.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

await main();