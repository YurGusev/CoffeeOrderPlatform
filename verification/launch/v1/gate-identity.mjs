export const GATE_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

// Старые id нужны только для чтения прогонов, созданных до перехода на slug.
export const LEGACY_GATE_IDS = Object.freeze({
  G00_PREFLIGHT: "preflight",
  G01_INSTALL: "install",
  G02_GENERATED: "generated",
  G03_STATIC: "static",
  G04_UNIT: "unit",
  G05_CONTRACTS: "contracts",
  G06_ARCHITECTURE: "architecture",
  G07_CONFIG_SECURITY: "config_security",
  G08_MIGRATIONS: "migrations",
  G09_DB_BOUNDARIES: "db_boundaries",
  G10_INTEGRATION: "integration",
  G11_RECOVERY: "recovery",
  G12_SUPPLY_CHAIN: "supply_chain",
  G13_COMPOSE: "compose",
  G14_OBSERVABILITY: "observability",
  G15_BROWSER: "browser",
  G16_AROMA_SANDBOX: "aroma_sandbox",
  G17_BACKUP_RESTORE: "backup_restore",
  G18_ROLLBACK: "rollback",
  G19_REPORT: "report",
});

export function gateSlug(id) {
  if (typeof id !== "string") return null;
  if (GATE_SLUG_PATTERN.test(id)) return id;
  return LEGACY_GATE_IDS[id] ?? null;
}

export function gateLabel(position, slug) {
  return `G${String(position).padStart(2, "0")} ${slug}`;
}
