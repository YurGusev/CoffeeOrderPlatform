#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
);
const evidenceRoot = join(root, "evidence", "web-verify");
const documentTitle = "CoffeeOrderPlatform — Оператор";
const loginLinkName = "Войти через защищённый контур";
const gateTitle = "Требуется вход";

const covered = [
  {
    id: "session-root",
    path: "/",
    absent: ["Клиенты", "Начните поиск клиента"],
  },
  {
    id: "session-customers-closed",
    path: "/app/customers",
    absent: ["Начните поиск клиента", "Новый клиент"],
  },
  {
    id: "session-catalog-closed",
    path: "/app/catalog",
    absent: ["Поиск товаров", "Не выбран заказ"],
  },
  {
    id: "session-new-order-closed",
    path: "/app/orders/new",
    absent: ["Новый заказ", "Сначала выберите клиента"],
  },
  {
    id: "session-order-closed",
    path: "/app/orders/not-an-order",
    absent: ["Заказ не найден", "Состав заказа", "Некорректный orderRef"],
  },
  {
    id: "session-unknown-closed",
    path: "/no-such-page",
    absent: ["Маршрут не найден"],
  },
];

const notCovered = [
  [
    "session-loading",
    "Надпись «Проверяем сессию оператора» не фиксируется отдельно.",
  ],
  [
    "session-unavailable",
    "Экран «Не удалось проверить сессию» нужен при HTTP 500 и выше от GET /auth/session.",
  ],
  [
    "root-redirect",
    "Переход с / на /app/customers выполняется только после сессии.",
  ],
  [
    "app-index-redirect",
    "Переход с /app на /app/customers выполняется только после сессии.",
  ],
  [
    "customers-search",
    "Поиск клиентов рисуется только после GET /auth/session 200.",
  ],
  [
    "customers-create",
    "Диалог «Новый клиент» рисуется только после сессии.",
  ],
  [
    "catalog-without-order",
    "Текст «Не выбран заказ» рисуется только после сессии.",
  ],
  [
    "catalog-search",
    "Поиск товаров рисуется только после сессии и orderRef.",
  ],
  [
    "catalog-add",
    "Кнопка «Добавить» рисуется только после сессии и выдачи каталога.",
  ],
  [
    "new-order-without-customer",
    "Текст «Сначала выберите клиента» рисуется только после сессии.",
  ],
  [
    "new-order-create",
    "Кнопка «Создать черновик» рисуется только после сессии и customerRef.",
  ],
  [
    "order-card-read",
    "Карточка заказа читает owner API после сессии.",
  ],
  [
    "order-card-items",
    "Количество и удаление позиции доступны только на открытой карточке.",
  ],
  [
    "order-card-confirm",
    "Диалог «Подтвердить заказ?» доступен только на открытой карточке.",
  ],
  [
    "order-card-reconcile",
    "Диалог «Запросить сверку AROMA?» доступен только на открытой карточке.",
  ],
  [
    "not-found-page",
    "Заголовок «Маршрут не найден» стоит за SessionBoundary и без сессии не показывается.",
  ],
  ["logout", "Кнопка «Выйти» стоит в оболочке после сессии."],
  [
    "pending-recovery",
    "Блок «Восстановление команд» стоит в оболочке после сессии.",
  ],
  [
    "realtime-status",
    "Статус «Соединение обновлений» стоит в оболочке после сессии.",
  ],
];

function runId() {
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace("T", "t");
  return `${stamp}z-${randomBytes(3).toString("hex")}`;
}

function returnTo(path) {
  return path.startsWith("/app/") ? path : "/app/customers";
}

function loginHref(path) {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo(path))}`;
}

function scenarioSeed() {
  return [
    ...covered.map((item) => ({
      id: item.id,
      status: "pending",
      path: item.path,
      href: loginHref(item.path),
    })),
    ...notCovered.map(([id, reason]) => ({
      id,
      status: "not-covered",
      reason,
    })),
  ];
}

function writeResult(dir, status, scenarios) {
  const passed = scenarios.filter((item) => item.status === "pass").length;
  const failed = scenarios.filter((item) => item.status === "fail").length;
  const uncovered = scenarios.filter(
    (item) => item.status === "not-covered",
  ).length;
  const payload = { status, passed, failed, notCovered: uncovered, scenarios };
  writeFileSync(join(dir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function stripAnsi(text) {
  return text.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function gitValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function listenInodes(port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const lines = readFileSync(file, "utf8").split("\n").slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10 || parts[3] !== "0A") continue;
      const [address, remotePort] = parts[1].split(":");
      if (remotePort !== hexPort) continue;
      const loopback =
        file.endsWith("tcp6")
          ? address === "00000000000000000000000001000000"
          : address === "0100007F";
      if (!loopback) continue;
      inodes.add(parts[9]);
    }
  }
  return inodes;
}

function pidsWithRun(id) {
  const found = [];
  const needle = `VERIFY_WEB_RUN=${id}`;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = readFileSync(join("/proc", entry, "environ"));
      const items = raw.toString("utf8").split("\0");
      if (items.includes(needle)) found.push(Number(entry));
    } catch {
      // Процесс уже завершился или environ недоступен.
    }
  }
  return found;
}

function pidHasInode(pid, inodes) {
  let fds;
  try {
    fds = readdirSync(join("/proc", String(pid), "fd"));
  } catch {
    return false;
  }
  for (const fd of fds) {
    try {
      const target = readlinkSync(join("/proc", String(pid), "fd", fd));
      const match = /^socket:\[(\d+)\]$/u.exec(target);
      if (match && inodes.has(match[1])) return true;
    } catch {
      // fd закрылся между чтением каталога и readlink.
    }
  }
  return false;
}

function runOwnsPort(id, port) {
  const inodes = listenInodes(port);
  if (inodes.size === 0) return false;
  return pidsWithRun(id).some((pid) => pidHasInode(pid, inodes));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function stopMarked(id, storedPid) {
  const marked = () => pidsWithRun(id);
  if (marked().length === 0) return;
  if (storedPid && marked().includes(storedPid)) {
    try {
      process.kill(-storedPid, "SIGTERM");
    } catch {
      // Группа уже завершилась.
    }
  }
  for (const pid of marked()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Процесс уже завершился.
    }
  }
  await delay(1000);
  for (const pid of marked()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Процесс уже завершился.
    }
  }
}

function usage() {
  console.error("usage: node .cursor/skills/verify-web/run.mjs [--down <run-id>]");
}

async function down(id) {
  if (!/^\d{8}t\d{6}z-[0-9a-f]{6}$/u.test(id ?? "")) {
    usage();
    return 1;
  }
  const runPath = join(evidenceRoot, id, "run.json");
  if (!existsSync(runPath)) {
    console.error(`нет ${runPath}`);
    return 1;
  }
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  await stopMarked(id, run.pid);
  const left = pidsWithRun(id);
  if (left.length > 0) {
    console.error(`процессы прогона ещё живы: ${left.join(", ")}`);
    return 1;
  }
  console.log(`verify-web ${id} остановлен, evidence сохранён`);
  return 0;
}

async function waitForReady(child, port, logPath) {
  let log = "";
  const append = (chunk) => {
    log += chunk.toString();
    writeFileSync(logPath, stripAnsi(log));
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (stripAnsi(log).includes(`http://127.0.0.1:${port}/`)) return;
    if (child.exitCode !== null) {
      throw new Error(`Vite завершился с кодом ${child.exitCode}`);
    }
    await delay(200);
  }
  throw new Error("Vite не напечатал Local URL за 60 с");
}

async function doctor(id, port) {
  const origin = `http://127.0.0.1:${port}`;
  let httpStatus = 0;
  let body = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(origin);
      httpStatus = response.status;
      body = await response.text();
      if (httpStatus === 200 && body.includes('id="root"')) break;
    } catch {
      httpStatus = 0;
    }
    await delay(250);
  }
  const titleFound = body.includes(documentTitle);
  const portOwned = runOwnsPort(id, port);
  return {
    origin,
    httpStatus,
    titleFound,
    portOwned,
    ok: httpStatus === 200 && titleFound && portOwned,
  };
}

async function driveScenario(page, origin, item, timeout) {
  await page.goto(`${origin}${item.path}`, {
    timeout,
    waitUntil: "domcontentloaded",
  });
  await page.getByText(gateTitle, { exact: true }).waitFor({ timeout });
  const link = page.getByRole("link", { name: loginLinkName });
  await link.waitFor({ timeout: 5_000 });
  const href = await link.getAttribute("href");
  const actual = new URL(href ?? "", origin);
  const expected = new URL(loginHref(item.path), origin);
  if (`${actual.pathname}${actual.search}` !== `${expected.pathname}${expected.search}`) {
    throw new Error(
      `ссылка входа ${actual.pathname}${actual.search}, ожидалась ${expected.pathname}${expected.search}`,
    );
  }
  const title = await page.title();
  if (title !== documentTitle) throw new Error(`title «${title}»`);
  const body = await page.locator("body").innerText();
  if (!body.includes(gateTitle)) throw new Error("на экране нет «Требуется вход»");
  for (const text of item.absent) {
    if (body.includes(text)) {
      throw new Error(`на экране входа виден текст закрытого экрана «${text}»`);
    }
  }
  if ((await page.getByRole("button", { name: "Выйти" }).count()) > 0) {
    throw new Error("кнопка «Выйти» видна без сессии");
  }
  const main = page.locator("main");
  const aria = await main.ariaSnapshot();
  return { title, href: `${actual.pathname}${actual.search}`, body, aria };
}

async function run() {
  const id = runId();
  const dir = join(evidenceRoot, id);
  const shotDir = join(dir, "screenshots");
  mkdirSync(shotDir, { recursive: true });
  const scenarios = scenarioSeed();
  writeResult(dir, "incomplete", scenarios);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    "pnpm",
    [
      "--dir",
      "apps/web",
      "exec",
      "vite",
      "--config",
      "vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root,
      detached: true,
      env: {
        ...process.env,
        BROWSER: "none",
        CI: "1",
        VERIFY_WEB_RUN: id,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const runInfo = {
    runId: id,
    pid: child.pid,
    port,
    origin,
    command: [
      "pnpm",
      "--dir",
      "apps/web",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
  };
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(runInfo, null, 2)}\n`);
  writeFileSync(
    join(dir, "environment.json"),
    `${JSON.stringify(
      {
        commit: gitValue(["rev-parse", "HEAD"]),
        dirty: gitValue(["status", "--porcelain"]).length > 0,
        origin,
      },
      null,
      2,
    )}\n`,
  );
  let browser;
  let exitCode = 1;
  try {
    await waitForReady(child, port, join(dir, "vite.log"));
    const checked = await doctor(id, port);
    writeFileSync(
      join(dir, "doctor.json"),
      `${JSON.stringify(checked, null, 2)}\n`,
    );
    if (!checked.ok) {
      throw new Error(
        `doctor: http ${checked.httpStatus}, title ${checked.titleFound}, port ${checked.portOwned}`,
      );
    }
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { height: 800, width: 1280 },
    });
    const page = await context.newPage();
    const browserLog = [];
    page.on("response", (response) => {
      if (response.status() < 400) return;
      browserLog.push(`http ${response.status()} ${response.url()}`);
    });
    page.on("console", (message) => {
      browserLog.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      browserLog.push(`pageerror: ${error.message}`);
    });
    for (const [index, item] of covered.entries()) {
      const scenario = scenarios.find((entry) => entry.id === item.id);
      const timeout = index === 0 ? 120_000 : 30_000;
      try {
        const proof = await driveScenario(page, origin, item, timeout);
        await page.screenshot({
          fullPage: true,
          path: join(shotDir, `${item.id}.png`),
        });
        writeFileSync(join(shotDir, `${item.id}.aria.txt`), `${proof.aria}\n`);
        scenario.status = "pass";
        scenario.documentTitle = proof.title;
        scenario.href = proof.href;
        scenario.screenshot = `screenshots/${item.id}.png`;
      } catch (error) {
        scenario.status = "fail";
        scenario.error = error instanceof Error ? error.message : String(error);
        try {
          await page.screenshot({
            fullPage: true,
            path: join(shotDir, `${item.id}.png`),
          });
          scenario.screenshot = `screenshots/${item.id}.png`;
          scenario.body = await page.locator("body").innerText();
        } catch {
          // Экран мог не открыться. Текст ошибки уже записан.
        }
        writeFileSync(join(dir, "browser.log"), `${browserLog.join("\n")}\n`);
        for (const entry of scenarios) {
          if (entry.status === "pending") entry.status = "not-run";
        }
        writeResult(dir, "fail", scenarios);
        throw error;
      }
    }
    writeFileSync(join(dir, "browser.log"), `${browserLog.join("\n")}\n`);
    const payload = writeResult(dir, "pass", scenarios);
    console.log(
      `verify-web ${id} pass ${payload.passed} passed, ${payload.failed} failed, ${payload.notCovered} not-covered`,
    );
    console.log(`evidence: evidence/web-verify/${id}`);
    exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`verify-web ${id} fail: ${message}`);
    for (const entry of scenarios) {
      if (entry.status === "pending") entry.status = "not-run";
    }
    if (!scenarios.some((item) => item.status === "fail")) {
      scenarios.push({ id: "launch", status: "fail", error: message });
    }
    const payload = writeResult(dir, "fail", scenarios);
    console.error(
      `verify-web ${id} ${payload.passed} passed, ${payload.failed} failed, ${payload.notCovered} not-covered`,
    );
    console.error(`evidence: evidence/web-verify/${id}`);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    await stopMarked(id, child.pid);
    const left = pidsWithRun(id);
    if (left.length > 0) {
      console.error(`после очистки живы процессы: ${left.join(", ")}`);
      exitCode = 1;
    }
  }
  return exitCode;
}

async function main() {
  if (!existsSync(join(root, "apps/web/package.json"))) {
    console.error(`корень не похож на репозиторий: ${root}`);
    return 1;
  }
  const args = process.argv.slice(2);
  if (args[0] === "--down") return down(args[1]);
  if (args.length !== 0) {
    usage();
    return 1;
  }
  return run();
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
