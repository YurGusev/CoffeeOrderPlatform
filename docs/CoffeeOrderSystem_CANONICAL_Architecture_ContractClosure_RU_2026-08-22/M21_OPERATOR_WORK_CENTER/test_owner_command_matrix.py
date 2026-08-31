#!/usr/bin/env python3
"""Directory-scoped positive and negative checks for the M21 command matrix."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent
MATRIX_PATH = ROOT / "owner-command-matrix.json"
SCHEMA_PATH = ROOT / "owner-command-matrix.schema.json"

EXPECTED_COMMANDS = {
    "reprice-draft",
    "resolve-customer-duplicate-link",
    "request-catalog-remap",
    "trigger-aroma-fresh-reconciliation",
    "save-manual-invoice-allocation",
    "retry-invoice-price-application",
    "payment-reconciliation-refund",
    "review-activate-delivery-coefficient",
}


class MatrixError(ValueError):
    """The matrix is not a closed, safe owner-command contract."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise MatrixError(message)


def validate_matrix(matrix: dict) -> None:
    """Validate the safety properties a consumer must enforce before use."""

    required_root = {
        "$schema",
        "schemaVersion",
        "contractId",
        "status",
        "owner",
        "scope",
        "commandEnvelope",
        "commands",
        "denials",
        "evidenceOwner",
        "evidenceRefs",
    }
    require(required_root <= matrix.keys(), "matrix root is missing required fields")
    require(matrix["schemaVersion"] == 1, "unsupported matrix schema")
    require(matrix["status"] == "SPECIFICATION_ONLY", "matrix must not authorize runtime")
    require(matrix["owner"] == "operator-work-center", "unexpected matrix owner")
    require(matrix["scope"]["workCenterDatabaseWrites"] == "forbidden", "Work Center DB writes must be forbidden")
    require(matrix["scope"]["businessStateOwner"] == "command-owning-bounded-context", "business state owner boundary changed")
    require(matrix["scope"]["queueResolution"] == "requires-authoritative-owner-fact", "queue resolution must require owner fact")
    require(matrix["scope"]["acceptedActionCount"] == 8, "M21 must contain exactly eight accepted commands")
    require(matrix["evidenceOwner"] == "next-work-center", "unexpected evidence owner")
    require(matrix["evidenceRefs"], "root evidence references are required")

    envelope = matrix["commandEnvelope"]
    actor = envelope["actor"]
    require(actor["required"] is True and actor["clientSupplied"] is False, "actor must be server-derived")
    require(actor["capabilityCheckedByServer"] is True, "capability must be checked server-side")
    require(envelope["reason"]["required"] is True, "reason is required")
    require(envelope["expectedVersionOrFingerprint"]["required"] is True, "stale guard is required")
    require(envelope["idempotency"] == {
        "header": "Idempotency-Key",
        "required": True,
        "serverGeneratedFallback": False,
        "scope": "owning-context-operation-target",
    }, "idempotency contract changed")
    require(envelope["trace"]["correlationId"]["required"] is True, "correlationId is required")
    require(envelope["trace"]["causationId"]["required"] is True, "causationId is required")
    require(envelope["workCenterItemRef"]["required"] is True, "workCenterItemRef is required")

    commands = matrix["commands"]
    require(isinstance(commands, list) and len(commands) == 8, "accepted command count is not eight")
    ids = [command.get("id") for command in commands]
    require(set(ids) == EXPECTED_COMMANDS and len(ids) == len(set(ids)), "command allowlist is not exactly the evidence set")
    operation_ids: set[str] = set()

    for command in commands:
        command_id = command.get("id", "<missing>")
        require(command.get("accepted") is True, f"{command_id}: command is not accepted")
        require(command.get("method") == "POST", f"{command_id}: only explicit POST owner commands are accepted")
        route = command.get("route", "")
        require(re.fullmatch(r"/api/(client-v1|agent-v1|internal-v1)/[^ ]+", route) is not None, f"{command_id}: route is not absolute")
        require("/work-center/" not in route, f"{command_id}: Work Center cannot be a business writer")
        require("repair" not in route.lower() and "patch" not in route.lower(), f"{command_id}: generic repair route denied")
        operation_id = command.get("operationId", "")
        require(re.fullmatch(r"[A-Za-z][A-Za-z0-9]+", operation_id) is not None, f"{command_id}: invalid operationId")
        require(operation_id not in operation_ids, f"{command_id}: duplicate operationId")
        operation_ids.add(operation_id)
        require(command.get("owningBoundedContext") not in {"work-center", "operator-work-center"}, f"{command_id}: Work Center owns business state")
        require(command.get("owner") == command["owningBoundedContext"], f"{command_id}: owner differs from bounded context")
        require(isinstance(command.get("capability"), str) and command["capability"], f"{command_id}: capability is missing")

        command_actor = command.get("actor", {})
        require(command_actor.get("serverDerived") is True and command_actor.get("clientSupplied") is False, f"{command_id}: actor is not server-derived")
        reason = command.get("reason", {})
        require(reason.get("required") is True and reason.get("field") == "reason" and reason.get("storedWithCommandAudit") is True, f"{command_id}: reason metadata is incomplete")
        stale = command.get("expectedVersionOrFingerprint", {})
        stale_fields = stale.get("fields", [])
        require(stale.get("required") is True and stale_fields, f"{command_id}: stale guard is incomplete")
        require(any("version" in field.lower() or "fingerprint" in field.lower() or "hash" in field.lower() for field in stale_fields), f"{command_id}: no expected version/fingerprint guard")
        require(command.get("idempotencyKey") == {"header": "Idempotency-Key", "required": True}, f"{command_id}: Idempotency-Key is incomplete")
        trace = command.get("correlationAndCausation", {})
        require(trace.get("correlationId") == "required" and trace.get("causationId") == "required", f"{command_id}: correlation/causation is incomplete")
        require(trace.get("serverGeneratedOrPropagated") is True, f"{command_id}: trace IDs are not server controlled")

        audit = command.get("auditEvent", {})
        require(audit.get("required") is True, f"{command_id}: audit event is missing")
        require(audit.get("eventType") and audit.get("eventId") == "server-generated", f"{command_id}: audit event identity is incomplete")
        audit_fields = {field.lower() for field in audit.get("fields", [])}
        require({"actor", "reason", "correlationid"} <= audit_fields, f"{command_id}: audit fields omit actor/reason/correlationId")
        require(any("version" in field or "fingerprint" in field or "hash" in field for field in audit_fields), f"{command_id}: audit omits stale guard")
        require(audit.get("owner") == command["owningBoundedContext"], f"{command_id}: audit owner differs from command owner")

        outbox = command.get("outbox", {})
        require(outbox.get("required") is True and outbox.get("transactional") is True, f"{command_id}: transactional outbox is required")
        require(outbox.get("owner") == command["owningBoundedContext"], f"{command_id}: outbox owner differs from command owner")
        require(outbox.get("publication") and outbox.get("topicReason"), f"{command_id}: outbox publication evidence is incomplete")
        require("work center" not in outbox.get("publication", "").lower() or "no Work Center" in outbox.get("publication", ""), f"{command_id}: Work Center cannot own outbox business writes")

        completion = command.get("authoritativeCompletionFact", {})
        require(completion.get("required") is True and completion.get("facts"), f"{command_id}: completion fact is missing")
        require(isinstance(command.get("completionFact"), str) and command["completionFact"], f"{command_id}: semantic completion fact is missing")
        require(completion.get("queueMayResolveOnlyAfterFact") is True, f"{command_id}: queue can resolve without owner fact")
        require(completion.get("evidence"), f"{command_id}: completion evidence is missing")

        rollback = command.get("rollback", {})
        require(rollback.get("required") is True and rollback.get("policy"), f"{command_id}: rollback policy is missing")
        require(rollback.get("owner") == command["owningBoundedContext"], f"{command_id}: rollback owner differs from command owner")
        require(rollback.get("blindRetry") is False and rollback.get("workCenterSql") is False, f"{command_id}: unsafe rollback policy")
        require(command.get("evidenceOwner") == "next-work-center" and len(command.get("evidenceRefs", [])) >= 2, f"{command_id}: evidence ownership is incomplete")

    denials = matrix["denials"]
    denial_ids = {denial.get("id") for denial in denials}
    require({"generic-repair-endpoint", "universal-patch", "work-center-db-business-write", "resolve-without-owner-fact"} <= denial_ids, "required denial rules are missing")
    for denial in denials:
        require(denial.get("decision") == "DENY", f"{denial.get('id')}: denial decision changed")
        require(denial.get("operationIdPattern") and denial.get("reason"), f"{denial.get('id')}: denial rationale is missing")


def expect_rejected(label: str, candidate: dict) -> None:
    try:
        validate_matrix(candidate)
    except MatrixError:
        return
    raise AssertionError(f"negative case unexpectedly accepted: {label}")


def main() -> int:
    matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    require(schema.get("$schema", "").startswith("https://json-schema.org/"), "schema dialect is missing")
    schema_required = set(schema.get("required", []))
    require({"commands", "denials", "commandEnvelope", "evidenceOwner"} <= schema_required, "schema omits contract sections")

    validate_matrix(matrix)

    missing_audit = deepcopy(matrix)
    del missing_audit["commands"][0]["auditEvent"]
    expect_rejected("missing audit event", missing_audit)

    missing_completion = deepcopy(matrix)
    del missing_completion["commands"][1]["authoritativeCompletionFact"]
    del missing_completion["commands"][1]["completionFact"]
    expect_rejected("missing completion fact", missing_completion)

    missing_rollback = deepcopy(matrix)
    del missing_rollback["commands"][2]["rollback"]
    expect_rejected("missing rollback", missing_rollback)

    missing_reason = deepcopy(matrix)
    missing_reason["commands"][3]["reason"]["required"] = False
    expect_rejected("missing reason", missing_reason)

    missing_stale_guard = deepcopy(matrix)
    missing_stale_guard["commands"][4]["expectedVersionOrFingerprint"]["fields"] = []
    expect_rejected("missing expected version/fingerprint", missing_stale_guard)

    generic_repair = deepcopy(matrix)
    generic_repair["commands"][0]["route"] = "/api/client-v1/work-center/repair"
    expect_rejected("generic repair endpoint", generic_repair)

    universal_patch = deepcopy(matrix)
    universal_patch["commands"][0]["method"] = "PATCH"
    expect_rejected("universal PATCH", universal_patch)

    work_center_write = deepcopy(matrix)
    work_center_write["commands"][0]["owningBoundedContext"] = "work-center"
    expect_rejected("Work Center business write", work_center_write)

    unknown_command = deepcopy(matrix)
    unknown_command["commands"][0]["id"] = "generic-repair"
    expect_rejected("unknown command", unknown_command)

    print("M21 owner-command matrix: positive acceptance passed")
    print("M21 owner-command matrix: negative denials passed (audit/completion/rollback/metadata/generic mutation/Work Center DB)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, MatrixError, json.JSONDecodeError) as error:
        print(f"M21 owner-command matrix: FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
