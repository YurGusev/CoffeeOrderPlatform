// Сгенерировано scripts/generate-gate-matrix.mjs из matrix.yaml; не редактировать вручную.
export const EXPECTED_GATES = [
  ["preflight", "pnpm launch:verify:preflight", 900],
  ["install", "pnpm install --frozen-lockfile", 900],
  ["generated", "pnpm contracts:check-generated", 900],
  ["static", "pnpm format:check && pnpm lint && pnpm typecheck", 900],
  ["unit", "pnpm test:unit -- --coverage", 900],
  [
    "contracts",
    "pnpm contracts:check-generated && pnpm contracts:breaking && pnpm contracts:test",
    900,
  ],
  ["architecture", "pnpm architecture:check", 900],
  [
    "config_security",
    "pnpm versions:check && pnpm config:check && pnpm security:secrets",
    900,
  ],
  ["supply_chain", "pnpm security:scan", 2700],
  [
    "migrations",
    "pnpm test:migrations:clean && pnpm test:migrations:forward",
    1800,
  ],
  ["db_boundaries", "pnpm db:smoke", 1800],
  ["integration", "pnpm test:integration", 1800],
  ["recovery", "pnpm test:recovery", 1800],
  ["compose", "pnpm test:compose-smoke", 1800],
  ["observability", "pnpm test:observability", 1800],
  ["browser", "pnpm test:playwright", 1800],
  [
    "aroma_sandbox",
    'pnpm test:aroma-sandbox -- --approval-file "$AROMA_SANDBOX_APPROVAL_FILE"',
    1800,
  ],
  ["backup_restore", "pnpm test:backup-restore", 1800],
  ["rollback", "pnpm test:mutation-disable-rollback", 1800],
  ["report", "pnpm launch:verify:report", 900],
];
