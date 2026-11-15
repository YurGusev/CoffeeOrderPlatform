import { EXPECTED_GATES } from "./gate-matrix.generated.mjs";
import { gateSlug } from "./gate-identity.mjs";

// `report` публикуется отдельным reportStatus и не участвует в решении о допуске.
const REPORT_GATE_ID = "report";

// PASS этих гейтов детерминирован входными хешами и может быть переиспользован
// при совпадении resume identity. Остальные гейты снимают живое состояние.
export const RESUMABLE_GATE_IDS = new Set([
  "install",
  "generated",
  "static",
  "unit",
  "contracts",
  "architecture",
  "config_security",
  "supply_chain",
]);
const SNAPSHOT_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function reportGateStatus(gates) {
  return (
    gates.find((gate) => gateSlug(gate?.id) === REPORT_GATE_ID)?.status ??
    "NOT_RUN"
  );
}

function workingGatesComplete(gates) {
  const workingGateIds = gates
    .map((gate) => gateSlug(gate?.id))
    .filter((id) => id !== REPORT_GATE_ID);
  return (
    gates.length === EXPECTED_GATES.length &&
    workingGateIds.length === EXPECTED_GATES.length - 1 &&
    EXPECTED_GATES.every(
      ([id]) => id === REPORT_GATE_ID || workingGateIds.includes(id),
    )
  );
}

function workingGatePass(gate) {
  if (gate.status !== "PASS" || !Array.isArray(gate.runs)) return false;
  if (gate.reusedFrom === undefined || gate.reusedFrom === null)
    return gate.runs.length > 0;
  // Переиспользованный PASS допустим только для разрешённого списка и без
  // собственных command runs: source evidence не переписывается.
  if (
    gate.runs.length !== 0 ||
    typeof gate.reusedFrom.runId !== "string" ||
    typeof gate.reusedFrom.evidenceDir !== "string"
  )
    return false;
  // preflight переиспользуется только как admission-результат, замороженный
  // вместе с GitHub-снимком; остальные разрешённые гейты не снимают живое
  // состояние.
  if (gateSlug(gate.id) === "preflight")
    return (
      SNAPSHOT_SHA256_PATTERN.test(
        gate.reusedFrom.githubSnapshotSha256 ?? "",
      ) &&
      SNAPSHOT_SHA256_PATTERN.test(
        gate.reusedFrom.preflightArtifactSha256 ?? "",
      )
    );
  return RESUMABLE_GATE_IDS.has(gateSlug(gate.id));
}

// Только release без фильтров и при всех 19 рабочих PASS даёт ДОПУСТИТЬ.
// Статус report в решение не входит и публикуется отдельным reportStatus.
export function decisive(gates, profile = "release") {
  if (profile !== "release" || !Array.isArray(gates)) return "НЕ ДОПУСТИТЬ";
  return workingGatesComplete(gates) &&
    gates.every(
      (gate) => gateSlug(gate?.id) === REPORT_GATE_ID || workingGatePass(gate),
    )
    ? "ДОПУСТИТЬ"
    : "НЕ ДОПУСТИТЬ";
}
