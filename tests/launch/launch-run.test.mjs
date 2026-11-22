import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = join(REPO_ROOT, "scripts/launch-run.mjs");
const SHA = "a".repeat(40);

async function launchEnvironment(t) {
  const root = await mkdtemp(join(tmpdir(), "coffee-launch-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const dockerCalls = join(root, "docker-calls");
  await mkdir(bin);
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(dockerCalls)}\nexit 0\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "git"),
    '#!/bin/sh\nif [ "$1" = "status" ]; then exit 0; fi\nexit 1\n',
    { mode: 0o755 },
  );
  return { root, bin, state: join(root, "state"), dockerCalls };
}

function launch(environment, args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${environment.bin}:${process.env.PATH ?? ""}`,
      TMPDIR: environment.root,
      COFFEE_LAUNCH_STATE: environment.state,
      COFFEE_LAUNCH_NO_PRUNE: "1",
      ...env,
    },
  });
}

const SKIP_FLAGS = ["--skip-supply-chain", "--skip-soak", "--skip-run"];

void test("без --g08-expected-system-identifier завершается кодом 2 до Docker и состояния", async (t) => {
  const environment = await launchEnvironment(t);
  const result = launch(environment, SKIP_FLAGS);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--g08-expected-system-identifier/u);
  assert.equal(existsSync(environment.state), false);
  assert.equal(existsSync(environment.dockerCalls), false);
});

void test("нечисловой --g08-expected-system-identifier отклоняется до запуска", async (t) => {
  const environment = await launchEnvironment(t);
  const result = launch(environment, [
    "--sha",
    SHA,
    "--g08-expected-system-identifier",
    "abc",
    ...SKIP_FLAGS,
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--g08-expected-system-identifier/u);
  assert.equal(existsSync(environment.state), false);
  assert.equal(existsSync(environment.dockerCalls), false);
});

for (const variant of [
  { label: "без ведущего --", args: [] },
  { label: "с ведущим --", args: ["--"] },
]) {
  void test(`${variant.label} числовой идентификатор доходит до выбора кандидата без supply_chain, soak и прогона`, async (t) => {
    const environment = await launchEnvironment(t);
    // Фейковый git и заранее созданный каталог кандидата останавливают обёртку
    // ровно на выборе кандидата, не создавая worktree и не трогая настоящий Docker.
    await mkdir(join(environment.state, "candidates", SHA), {
      recursive: true,
    });
    const sopsKey = join(environment.root, "sops.key");
    await writeFile(sopsKey, "");
    const result = launch(
      environment,
      [
        ...variant.args,
        "--sha",
        SHA,
        "--g08-expected-system-identifier",
        "1234567890",
        "--min-free-gib",
        "0",
        ...SKIP_FLAGS,
      ],
      { SOPS_AGE_KEY_FILE: sopsKey },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /кандидат уже существует/u);
    assert.doesNotMatch(
      result.stderr,
      /неизвестный аргумент|--g08-expected-system-identifier/u,
    );
    assert.equal(existsSync(environment.dockerCalls), true);
    assert.doesNotMatch(
      result.stdout,
      /supply_chain\.\.\.|realtime qualification|полный прогон/u,
    );
  });
}

void test("-- вторым аргументом отклоняется как неизвестный", async (t) => {
  const environment = await launchEnvironment(t);
  const result = launch(environment, [
    "--sha",
    SHA,
    "--",
    "--g08-expected-system-identifier",
    "1234567890",
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /неизвестный аргумент: --/u);
  assert.equal(existsSync(environment.state), false);
  assert.equal(existsSync(environment.dockerCalls), false);
});
