import { EXPECTED_GATES } from "./gate-matrix.generated.mjs";
import { gateSlug } from "./gate-identity.mjs";

// `report` публикуется отдельным reportStatus и не участвует в решении о допуске.
const REPORT_GATE_ID = "report";

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

export function decisive(gates) {
  return workingGatesComplete(gates) &&
    gates.every(
      (gate) => gateSlug(gate?.id) === REPORT_GATE_ID || gate.status === "PASS",
    )
    ? "ДОПУСТИТЬ"
    : "НЕ ДОПУСТИТЬ";
}
