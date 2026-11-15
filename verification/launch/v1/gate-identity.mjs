export const GATE_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

// Старые id нужны только для чтения прогонов, созданных до перехода на slug.
export const LEGACY_GATE_IDS = Object.freeze({
  preflight: "preflight",
  install: "install",
  generated: "generated",
  static: "static",
  unit: "unit",
  contracts: "contracts",
  architecture: "architecture",
  config_security: "config_security",
  migrations: "migrations",
  db_boundaries: "db_boundaries",
  integration: "integration",
  recovery: "recovery",
  supply_chain: "supply_chain",
  compose: "compose",
  observability: "observability",
  browser: "browser",
  aroma_sandbox: "aroma_sandbox",
  backup_restore: "backup_restore",
  rollback: "rollback",
  report: "report",
});

export function gateSlug(id) {
  if (typeof id !== "string") return null;
  if (GATE_SLUG_PATTERN.test(id)) return id;
  return LEGACY_GATE_IDS[id] ?? null;
}

export function gateLabel(position, slug) {
  return `G${String(position).padStart(2, "0")} ${slug}`;
}
