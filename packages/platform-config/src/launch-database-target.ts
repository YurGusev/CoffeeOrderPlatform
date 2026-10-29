import { createHash } from "node:crypto";

export type LaunchDatabaseIdentity = Readonly<{
  schemaVersion: 1;
  runId: string;
  candidateSha: string;
  baseConfigSha256: string;
}>;
export type LaunchRunIdentity = Readonly<{
  runId: string;
  candidateSha: string;
}>;

export type DatabaseOwnershipDocument = Readonly<{
  schemaVersion: 1;
  authorityRef: "docs/launch/05_DATA_OWNERSHIP.md";
  databases: readonly Readonly<{ name: string; owner: string }>[];
  runtimeClaims: readonly Readonly<{
    runtime: string;
    database: string | null;
  }>[];
}>;

export type RuntimeDatabaseTarget = Readonly<{
  database: string;
  allowedDatabase: string;
  owner: string;
}>;

type ConfigForDatabaseTarget = Readonly<{
  environment: string;
  databaseIsolation?: Readonly<{ enabled: boolean }>;
  services: Readonly<
    Record<string, Readonly<{ database: string | null }> | undefined>
  >;
}>;

const LAUNCH_RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u;
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const CANONICAL_DATABASE_OWNERS = [
  "customer",
  "catalog",
  "pricing",
  "orders",
  "integration",
] as const;

export type LaunchConfigAttestation = Readonly<{
  baseConfigSha256: string;
  actualConfigSha256: string;
  phase: "base" | "disabled";
}>;

function adr0035DisabledFlagOffset(source: string): number {
  const lines = [...source.matchAll(/[^\n]*(?:\n|$)/gu)]
    .filter((line) => line[0] !== "")
    .map((line) => ({
      text: line[0]!.replace(/\r?\n$/u, ""),
      offset: line.index!,
    }));
  const mutationKeys = lines.filter(({ text }) =>
    /^[\t ]*mutationsEnabled[\t ]*:/u.test(text),
  );
  if (mutationKeys.length !== 1)
    fail("ADR-0035 D mutation flag is missing or ambiguous");

  const serviceRoots = lines.filter(({ text, offset }) =>
    /^services:[\t ]*(?:#.*)?$/u.test(
      offset === 0 && text.startsWith("\ufeff") ? text.slice(1) : text,
    ),
  );
  if (serviceRoots.length !== 1)
    fail("ADR-0035 D services section is missing or ambiguous");
  const servicesRootIndex = lines.indexOf(serviceRoots[0]!);
  const servicesEnd = lines.findIndex(
    ({ text }, index) =>
      index > servicesRootIndex && /^[^\t #][^:]*:/u.test(text),
  );
  const servicesLimit = servicesEnd < 0 ? lines.length : servicesEnd;
  const targetIndexes = lines
    .map(({ text }, index) => ({ text, index }))
    .filter(
      ({ text, index }) =>
        index > servicesRootIndex &&
        index < servicesLimit &&
        /^  aroma-convergence:[\t ]*(?:#.*)?$/u.test(text),
    );
  if (targetIndexes.length !== 1)
    fail("ADR-0035 D aroma-convergence service is missing or ambiguous");
  const targetIndex = targetIndexes[0]!.index;
  const targetEnd = lines.findIndex(
    ({ text }, index) =>
      index > targetIndex && /^  [A-Za-z0-9_-]+:[\t ]*(?:#.*)?$/u.test(text),
  );
  const targetLimit =
    targetEnd < 0 || targetEnd > servicesLimit ? servicesLimit : targetEnd;
  const flags = lines.filter(
    ({ text }, index) =>
      index > targetIndex &&
      index < targetLimit &&
      /^    mutationsEnabled:[\t ]*false[\t ]*(?:#.*)?$/u.test(text),
  );
  if (flags.length !== 1 || mutationKeys[0] !== flags[0])
    fail("ADR-0035 D mutation flag is missing, aliased or ambiguous");
  const flagLine = flags[0]!;
  return flagLine.offset + flagLine.text.indexOf("false");
}

function fail(message: string): never {
  throw new Error(`RUNTIME_DATABASE_TARGET_INVALID: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateLaunchDatabaseIdentity(
  value: unknown,
): LaunchDatabaseIdentity {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    value["schemaVersion"] !== 1 ||
    typeof value["baseConfigSha256"] !== "string" ||
    !SHA256_PATTERN.test(value["baseConfigSha256"])
  )
    fail("launch identity не совпадает с форматом run/SHA/config");
  const runIdentity = validateLaunchRunIdentity(value);
  return Object.freeze({
    schemaVersion: 1,
    ...runIdentity,
    baseConfigSha256: value["baseConfigSha256"],
  });
}

export function validateLaunchRunIdentity(value: unknown): LaunchRunIdentity {
  if (
    !isRecord(value) ||
    typeof value["runId"] !== "string" ||
    typeof value["candidateSha"] !== "string" ||
    !LAUNCH_RUN_ID_PATTERN.test(value["runId"]) ||
    !SHA1_PATTERN.test(value["candidateSha"]) ||
    !value["runId"].endsWith(`-${value["candidateSha"].slice(0, 7)}`)
  )
    fail("launch run identity не совпадает с форматом run/SHA");
  return Object.freeze({
    runId: value["runId"],
    candidateSha: value["candidateSha"],
  });
}

export function deriveLaunchDatabaseName(
  identity: LaunchRunIdentity,
  owner: string,
): string {
  const runIdentity = validateLaunchRunIdentity(identity);
  if (
    !CANONICAL_DATABASE_OWNERS.includes(
      owner as (typeof CANONICAL_DATABASE_OWNERS)[number],
    )
  )
    fail("launch database owner не входит в canonical owner set");
  return `coffee_verify_${runIdentity.runId.toLowerCase().replace("-", "_")}_${owner}`;
}

/** Verify exact B/R bytes or the sole ADR-0035 D change without accepting config overlays. */
export function verifyLaunchConfigBytes(
  input: Readonly<{
    actualConfigBytes: Uint8Array;
    baseConfigSha256: string;
    runtime: string;
    environment: string;
    databaseIsolationEnabled: boolean;
    mutationsEnabled: boolean | undefined;
  }>,
): LaunchConfigAttestation {
  const {
    actualConfigBytes,
    baseConfigSha256,
    runtime,
    environment,
    databaseIsolationEnabled,
    mutationsEnabled,
  } = input;
  if (
    !SHA256_PATTERN.test(baseConfigSha256) ||
    !databaseIsolationEnabled ||
    environment === "production"
  )
    fail("launch config policy, environment or base digest invalid");

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      actualConfigBytes,
    );
  } catch {
    fail("launch config bytes are not valid UTF-8");
  }
  const actualConfigSha256 = createHash("sha256")
    .update(actualConfigBytes)
    .digest("hex");
  if (actualConfigSha256 === baseConfigSha256)
    return Object.freeze({
      baseConfigSha256,
      actualConfigSha256,
      phase: "base",
    });

  if (runtime !== "aroma-convergence" || mutationsEnabled !== false)
    fail("only disabled aroma-convergence may use the ADR-0035 D config");
  const falseOffset = adr0035DisabledFlagOffset(source);
  const reconstructed = Buffer.from(
    `${source.slice(0, falseOffset)}true${source.slice(falseOffset + "false".length)}`,
    "utf8",
  );
  const reconstructedSha256 = createHash("sha256")
    .update(reconstructed)
    .digest("hex");
  if (reconstructedSha256 !== baseConfigSha256)
    fail("ADR-0035 D config differs from B beyond the literal mutation flag");
  return Object.freeze({
    baseConfigSha256,
    actualConfigSha256,
    phase: "disabled",
  });
}

/** Derive a runtime database only from configured ownership and the trusted run identity. */
export function deriveRuntimeDatabaseTarget(
  input: Readonly<{
    config: ConfigForDatabaseTarget;
    runtime: string;
    ownership: unknown;
    launchIdentity?: LaunchDatabaseIdentity;
  }>,
): RuntimeDatabaseTarget {
  const { config, runtime, ownership, launchIdentity } = input;
  const path = `config.services.${runtime}.database`;
  const configuredDatabase = config.services[runtime]?.database;
  if (typeof configuredDatabase !== "string" || configuredDatabase.length === 0)
    fail(`${path}: runtime не владеет базой данных`);

  if (
    !isRecord(ownership) ||
    ownership["schemaVersion"] !== 1 ||
    ownership["authorityRef"] !== "docs/launch/05_DATA_OWNERSHIP.md" ||
    !Array.isArray(ownership["databases"]) ||
    ownership["databases"].length !== CANONICAL_DATABASE_OWNERS.length ||
    !Array.isArray(ownership["runtimeClaims"])
  )
    fail(
      "config/database-ownership.json: некорректная canonical ownership authority",
    );
  const canonicalDatabases = new Set<string>();
  for (const database of ownership["databases"]) {
    if (
      !isRecord(database) ||
      typeof database["owner"] !== "string" ||
      !CANONICAL_DATABASE_OWNERS.includes(
        database["owner"] as (typeof CANONICAL_DATABASE_OWNERS)[number],
      ) ||
      database["name"] !== `coffee_platform_${database["owner"]}` ||
      canonicalDatabases.has(database["name"])
    )
      fail(
        "config/database-ownership.json: нарушена canonical owner/database mapping",
      );
    canonicalDatabases.add(database["name"] as string);
  }
  if (canonicalDatabases.size !== CANONICAL_DATABASE_OWNERS.length)
    fail(
      "config/database-ownership.json: отсутствует canonical owner database",
    );
  const runtimeClaims = ownership["runtimeClaims"].filter(
    (claim) => isRecord(claim) && claim["runtime"] === runtime,
  );
  if (
    runtimeClaims.length !== 1 ||
    !isRecord(runtimeClaims[0]) ||
    runtimeClaims[0]["database"] !== configuredDatabase
  )
    fail(`${path}: database не совпадает с единственным runtime claim`);

  const ownedDatabases = ownership["databases"].filter(
    (database) => isRecord(database) && database["name"] === configuredDatabase,
  );
  if (
    ownedDatabases.length !== 1 ||
    !isRecord(ownedDatabases[0]) ||
    typeof ownedDatabases[0]["owner"] !== "string"
  )
    fail(
      `${path}: database отсутствует или неоднозначна в ownership authority`,
    );
  const owner = ownedDatabases[0]["owner"] as string;
  if (
    !CANONICAL_DATABASE_OWNERS.includes(
      owner as (typeof CANONICAL_DATABASE_OWNERS)[number],
    ) ||
    configuredDatabase !== `coffee_platform_${owner}`
  )
    fail(`${path}: database имеет некорректный или foreign owner namespace`);

  const isolationEnabled = config.databaseIsolation?.enabled === true;
  if (!launchIdentity) {
    if (isolationEnabled) fail("enabled policy требует launch identity");
    return Object.freeze({
      database: configuredDatabase,
      allowedDatabase: configuredDatabase,
      owner,
    });
  }
  if (!isolationEnabled || config.environment === "production")
    fail("launch database isolation выключена или запрещена в production");
  validateLaunchDatabaseIdentity(launchIdentity);

  const database = deriveLaunchDatabaseName(launchIdentity, owner);
  if (database.length > 63 || !/^[a-z][a-z0-9_]*$/u.test(database))
    fail(`${path}: derived database identifier некорректен`);
  return Object.freeze({ database, allowedDatabase: database, owner });
}
