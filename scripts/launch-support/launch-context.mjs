import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `report` must work even when `preflight`/`install` failed before candidate dependencies were installed.
// Keep this small validation contract local and builtin-only.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function redactText(text) {
  return String(text)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
      "[REDACTED-URL]",
    )
    .replace(
      /\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie|client[_-]?secret)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    );
}

export async function assertNoSymlinkPath(root, target, allowMissing = false) {
  root = resolve(root);
  target = resolve(target);
  const suffix = relative(root, target);
  if (
    suffix === ".." ||
    suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(root, suffix) !== target
  )
    throw new Error("Evidence path выходит за доверенный root");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Trust root не является обычным каталогом");
  let current = root;
  for (const component of suffix.split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink())
      throw new Error(`Symlink запрещён: ${relative(root, current)}`);
  }
}

function gitValue(directory, ...args) {
  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Git identity validation failed: ${redactText(result.stderr || result.error?.message || "unknown error")}`,
    );
  return result.stdout.trim();
}

async function verifiedRepositoryRoot(directory) {
  const root = resolve(directory ?? "");
  const canonical = await realpath(root);
  if (canonical !== root)
    throw new Error("Repository root должен быть canonical path без symlink");
  if (
    (await realpath(gitValue(root, "rev-parse", "--show-toplevel"))) !==
    canonical
  )
    throw new Error("Git top-level не совпадает с repository root");
  const origin = gitValue(root, "remote", "get-url", "origin")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (origin !== "https://github.com/YurGusev/CoffeeOrderPlatform")
    throw new Error(
      "Repository origin не является canonical CoffeeOrderPlatform GitHub origin",
    );
  return canonical;
}

export async function validateLaunchContext(contextFile) {
  const contextPath = resolve(contextFile);
  const contextInfo = await lstat(contextPath);
  if (
    !contextInfo.isFile() ||
    contextInfo.isSymbolicLink() ||
    contextInfo.size > 16 * 1024
  )
    throw new Error(
      "Launch context должен быть обычным файлом не более 16 KiB",
    );
  if ((await realpath(contextPath)) !== contextPath)
    throw new Error("Launch context содержит symlink в пути");
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  if (
    context.schemaVersion !== 1 ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/.test(context.runId ?? "") ||
    !/^[0-9a-f]{40}$/.test(context.candidateSha ?? "")
  ) {
    throw new Error("Некорректный launch context v1");
  }
  const sourceRoot = await verifiedRepositoryRoot(context.sourceRepoRoot);
  const evidenceDir = resolve(sourceRoot, "evidence/launch", context.runId);
  if (
    resolve(context.evidenceDir ?? "") !== evidenceDir ||
    contextPath !== join(evidenceDir, "context.json")
  )
    throw new Error("Context path не совпадает с source root/run ID");
  await assertNoSymlinkPath(sourceRoot, contextPath);
  const candidateRoot = await verifiedRepositoryRoot(context.checkoutDir);
  if (
    candidateRoot !== resolve(context.checkoutDir) ||
    gitValue(candidateRoot, "rev-parse", "HEAD") !== context.candidateSha
  ) {
    throw new Error(
      "Candidate checkout root/SHA не совпадает с launch context",
    );
  }
  const executingRoot = await verifiedRepositoryRoot(PROJECT_ROOT);
  if (executingRoot !== sourceRoot && executingRoot !== candidateRoot)
    throw new Error(
      "Report module не запущен из source root или точного candidate checkout",
    );
  return { context, sourceRoot, evidenceDir, candidateRoot };
}
