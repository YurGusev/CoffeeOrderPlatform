#!/usr/bin/env python3
"""Fail-closed validation for issue #27 Effect contract-platform authority.

The validator is intentionally dependency-free. It validates the closed machine
contract, predecessor references and preserved architecture before production
contract code is allowed to replace the temporary PR #22 contract stack.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


EXPECTED_PROHIBITIONS = [
    "handwritten-openapi-source",
    "hey-api-transport-authority",
    "duplicated-contract-dto",
    "frontend-internal-v1-import",
    "client-internal-contract-collapse",
    "unversioned-event-schema",
    "eighth-launch-message-without-adr",
]

EXPECTED_SURFACE_ROOTS = {
    "client-v1": "packages/contracts/src/client-v1",
    "internal-v1": "packages/contracts/src/internal-v1",
    "events": "packages/contracts/src/events",
}


class ContractAuthorityError(ValueError):
    """The Effect contract-platform authority is incomplete or contradictory."""


class DuplicateKeyError(ValueError):
    """Strict JSON cannot contain duplicate object keys."""


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_object_pairs)
    except FileNotFoundError as error:
        raise ContractAuthorityError(f"required file is missing: {path}") from error
    except (UnicodeDecodeError, json.JSONDecodeError, DuplicateKeyError) as error:
        raise ContractAuthorityError(f"invalid strict JSON in {path}: {error}") from error
    if not isinstance(value, dict):
        raise ContractAuthorityError(f"JSON root must be an object: {path}")
    return value


def require(condition: bool, rule: str, message: str) -> None:
    if not condition:
        raise ContractAuthorityError(f"{rule}: {message}")


def exact_keys(value: Any, expected: set[str], rule: str, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), rule, f"{label} must be an object")
    assert isinstance(value, dict)
    missing = expected - value.keys()
    unknown = value.keys() - expected
    require(not missing, rule, f"{label} missing fields: {', '.join(sorted(missing))}")
    require(not unknown, rule, f"{label} unknown fields: {', '.join(sorted(unknown))}")
    return value


def validate_schema(schema: dict[str, Any]) -> None:
    require(
        schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema",
        "CONTRACT-SCHEMA-DIALECT",
        "companion schema must use JSON Schema draft 2020-12",
    )
    require(
        schema.get("type") == "object" and schema.get("additionalProperties") is False,
        "CONTRACT-SCHEMA-CLOSED",
        "companion schema root must be a closed object",
    )
    required = schema.get("required")
    require(isinstance(required, list), "CONTRACT-SCHEMA-REQUIRED", "schema required must be an array")
    expected = {
        "$schema",
        "schemaVersion",
        "issue",
        "authorityRef",
        "predecessor",
        "state",
        "sourceAuthority",
        "surfaceIsolation",
        "legacyReplacement",
        "preservedArchitecture",
        "prohibitions",
    }
    require(set(required) == expected, "CONTRACT-SCHEMA-REQUIRED", "schema root required set changed")


def validate_authority(root: Path) -> None:
    config_path = root / "config" / "effect-contract-platform.json"
    schema_path = root / "config" / "effect-contract-platform.schema.json"
    document = load_json(config_path)
    schema = load_json(schema_path)
    validate_schema(schema)

    exact_keys(
        document,
        {
            "$schema",
            "schemaVersion",
            "issue",
            "authorityRef",
            "predecessor",
            "state",
            "sourceAuthority",
            "surfaceIsolation",
            "legacyReplacement",
            "preservedArchitecture",
            "prohibitions",
        },
        "CONTRACT-AUTHORITY-CLOSED",
        "contract authority",
    )
    require(
        document["$schema"] == "./effect-contract-platform.schema.json",
        "CONTRACT-AUTHORITY-SCHEMA",
        "wrong companion schema",
    )
    require(document["schemaVersion"] == 1, "CONTRACT-AUTHORITY-VERSION", "schemaVersion must be 1")
    require(document["issue"] == 27, "CONTRACT-AUTHORITY-OWNER", "owner must be issue #27")
    require(
        document["authorityRef"] == "docs/adr/ADR-0023-effect-native-platform.md",
        "CONTRACT-AUTHORITY-ADR",
        "ADR-0023 must remain the authority",
    )
    require(
        document["state"] in {"in-progress", "implemented-awaiting-review", "accepted"},
        "CONTRACT-AUTHORITY-STATE",
        "unsupported lifecycle state",
    )

    predecessor = exact_keys(
        document["predecessor"],
        {"issue", "handoff", "baseBranch"},
        "CONTRACT-PREDECESSOR",
        "predecessor",
    )
    require(predecessor["issue"] == 26, "CONTRACT-PREDECESSOR", "predecessor must be issue #26")
    require(
        predecessor["handoff"] == "evidence/handoffs/issue-26.yaml",
        "CONTRACT-PREDECESSOR",
        "accepted handoff #26 is required",
    )
    require(predecessor["baseBranch"] == "develop", "CONTRACT-PREDECESSOR", "base branch must be develop")
    require(
        (root / predecessor["handoff"]).is_file(),
        "CONTRACT-PREDECESSOR",
        "handoff #26 is absent from the candidate tree",
    )

    source = exact_keys(
        document["sourceAuthority"],
        {
            "kind",
            "contractRoot",
            "surfaceRoots",
            "runtimeDecoder",
            "typedServerContract",
            "typedClient",
            "openApi",
            "jsonSchema",
        },
        "CONTRACT-SOURCE-AUTHORITY",
        "sourceAuthority",
    )
    require(source["kind"] == "effect-schema-httpapi", "CONTRACT-SOURCE-AUTHORITY", "Effect Schema + HttpApi is required")
    require(source["contractRoot"] == "packages/contracts/src", "CONTRACT-SOURCE-ROOT", "contract root changed")
    require(source["surfaceRoots"] == EXPECTED_SURFACE_ROOTS, "CONTRACT-SURFACE-ROOTS", "surface roots must remain exact and separate")
    require(source["runtimeDecoder"] == "effect-schema", "CONTRACT-RUNTIME-DECODER", "Effect Schema must decode runtime values")
    require(source["typedServerContract"] == "effect-httpapi", "CONTRACT-SERVER-TYPE", "HttpApi must own server typing")
    require(source["typedClient"] == "effect-httpapi-client", "CONTRACT-CLIENT-TYPE", "HttpApi client must own typed clients")

    openapi = exact_keys(source["openApi"], {"role", "version"}, "CONTRACT-OPENAPI", "openApi")
    require(openapi == {"role": "generated-artifact", "version": "3.1.0"}, "CONTRACT-OPENAPI", "OpenAPI must be generated 3.1.0")
    json_schema = exact_keys(source["jsonSchema"], {"role", "dialect"}, "CONTRACT-JSON-SCHEMA", "jsonSchema")
    require(
        json_schema == {
            "role": "generated-artifact",
            "dialect": "https://json-schema.org/draft/2020-12/schema",
        },
        "CONTRACT-JSON-SCHEMA",
        "JSON Schema must be generated draft 2020-12",
    )

    isolation = exact_keys(
        document["surfaceIsolation"],
        {
            "clientAndInternalPhysicallySeparated",
            "frontendInternalImportsAllowed",
            "eventSchemasVersioned",
            "sharedMutableBusinessDtosAllowed",
        },
        "CONTRACT-SURFACE-ISOLATION",
        "surfaceIsolation",
    )
    require(isolation["clientAndInternalPhysicallySeparated"] is True, "CONTRACT-SURFACE-ISOLATION", "client-v1 and internal-v1 must be physically separate")
    require(isolation["frontendInternalImportsAllowed"] is False, "CONTRACT-FRONTEND-INTERNAL", "frontend internal-v1 imports are forbidden")
    require(isolation["eventSchemasVersioned"] is True, "CONTRACT-EVENT-VERSION", "event schemas must be versioned")
    require(isolation["sharedMutableBusinessDtosAllowed"] is False, "CONTRACT-SHARED-DTO", "shared mutable business DTOs are forbidden")

    legacy = exact_keys(
        document["legacyReplacement"],
        {
            "inventory",
            "ownerIssue",
            "handwrittenOpenApiSourceAllowedAfterAcceptance",
            "heyApiGenerationAllowedAfterAcceptance",
            "duplicatedRuntimeDtoAllowedAfterAcceptance",
            "ajvRuntimeMirrorAllowedAfterAcceptance",
        },
        "CONTRACT-LEGACY-REPLACEMENT",
        "legacyReplacement",
    )
    require(legacy["inventory"] == "config/effect-legacy-inventory.json", "CONTRACT-LEGACY-REPLACEMENT", "legacy inventory reference changed")
    require((root / legacy["inventory"]).is_file(), "CONTRACT-LEGACY-REPLACEMENT", "legacy inventory is missing")
    require(legacy["ownerIssue"] == 27, "CONTRACT-LEGACY-REPLACEMENT", "contract legacy removal must belong to #27")
    for field in (
        "handwrittenOpenApiSourceAllowedAfterAcceptance",
        "heyApiGenerationAllowedAfterAcceptance",
        "duplicatedRuntimeDtoAllowedAfterAcceptance",
        "ajvRuntimeMirrorAllowedAfterAcceptance",
    ):
        require(legacy[field] is False, "CONTRACT-LEGACY-REPLACEMENT", f"{field} must remain false")

    preserved = exact_keys(
        document["preservedArchitecture"],
        {
            "deployableRuntimeCount",
            "logicalDatabaseCount",
            "providerEgressRuntime",
            "convergenceOwner",
            "durableTruth",
            "eventTransport",
        },
        "CONTRACT-PRESERVED-ARCHITECTURE",
        "preservedArchitecture",
    )
    require(
        preserved == {
            "deployableRuntimeCount": 15,
            "logicalDatabaseCount": 5,
            "providerEgressRuntime": "aroma-gateway",
            "convergenceOwner": "orders",
            "durableTruth": "postgresql",
            "eventTransport": "kafka-committed-facts-and-wake-up",
        },
        "CONTRACT-PRESERVED-ARCHITECTURE",
        "topology/data/provider invariants changed",
    )
    require(document["prohibitions"] == EXPECTED_PROHIBITIONS, "CONTRACT-PROHIBITIONS", "exact prohibition set/order changed")

    require((root / "docs" / "adr" / "ADR-0023-effect-native-platform.md").is_file(), "CONTRACT-AUTHORITY-ADR", "ADR-0023 is missing")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        validate_authority(args.root.resolve())
    except (ContractAuthorityError, OSError) as error:
        print(f"effect contract platform: FAIL: {error}", file=sys.stderr)
        return 1
    print("effect contract platform: positive authority validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
