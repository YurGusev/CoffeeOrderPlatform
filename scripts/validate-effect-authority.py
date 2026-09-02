#!/usr/bin/env python3
"""Fail-closed validation for the Effect-native runtime foundation decision.

The canonical source is platform/runtime-foundation-decision.json schema v2.
The previous issue-19 validator is retained for unchanged topology, connectivity
and target-layout invariants. It receives only a temporary v1 projection derived
from the canonical v2 document; no second authority file is stored.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
from typing import Any

NODE_VERSION = "26.8.1"
NPM_VERSION = "11.19.0"
COREPACK_VERSION = "0.35.0"
PNPM_VERSION = "11.24.0"
IMAGE_INDEX_DIGEST = "sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e"
IMAGE_AMD64_DIGEST = "sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae"

EFFECT_BOM = {
    "effect": "4.0.0-rc.112",
    "@effect/platform-node": "4.0.0-rc.112",
    "@effect/platform-browser": "4.0.0-rc.112",
    "@effect/sql-pg": "4.0.0-rc.112",
    "@effect/opentelemetry": "4.0.0-rc.112",
    "@effect/atom-react": "4.0.0-rc.112",
    "@effect/vitest": "4.0.0-rc.112",
    "@effect/tsgo": "0.39.0",
    "pg-copy-streams": "7.0.0",
}

ALLOWED_MODULE_PREFIXES = [
    "effect/",
    "effect/unstable/http/",
    "effect/unstable/httpapi/",
    "effect/unstable/sql/",
    "effect/unstable/encoding/",
    "effect/unstable/reactivity/",
    "@effect/platform-node",
    "@effect/platform-browser",
    "@effect/sql-pg",
    "@effect/opentelemetry",
    "@effect/atom-react",
    "@effect/vitest",
]

FORBIDDEN_MODULE_PREFIXES = [
    "effect/unstable/rpc/",
    "effect/unstable/workflow/",
    "effect/unstable/cluster/",
    "effect/unstable/persistence/",
    "effect/unstable/eventlog/",
    "effect/unstable/ai/",
    "effect/unstable/cli/",
    "effect/unstable/workers/",
]

AUTHORITIES = {
    "execution": "effect",
    "composition": "context-service-owner-local-layer",
    "lifecycle": "node-runtime-layer-launch-scope",
    "contracts": "effect-schema-httpapi",
    "http": "effect-http-router-httpapi-httpclient",
    "runtimeValidation": "effect-schema",
    "sql": "effect-sql-pg-with-coffee-transaction-policy",
    "time": "effect-clock-datetime-duration-testclock",
    "observability": "effect-opentelemetry",
    "frontendRemoteState": "effect-atom-httpapi",
    "backendTests": "vitest-effect-vitest",
    "durability": "postgresql-and-kafka",
}

PROHIBITIONS = [
    "node-24",
    "floating-image-tag",
    "placeholder-digest",
    "typescript-5-or-6",
    "second-typescript-compiler",
    "nightly-toolchain-pin",
    "compiler-api",
    "custom-transformer",
    "dual-runtime-stack",
    "shared-platform-live-across-owners",
    "effect-wrapper-framework",
    "effect-rpc",
    "effect-workflow",
    "effect-persistence",
    "effect-eventlog",
    "effect-cluster",
    "unsafe-aroma-mutation-retry",
]

ROOT_KEYS = {
    "$schema",
    "schemaVersion",
    "decisionId",
    "decisionRef",
    "preserves",
    "runtime",
    "productionImage",
    "registryVerification",
    "toolchainDecision",
    "effectPlatform",
    "preservedArchitecture",
    "prohibitions",
    "foundationMaterializationOwner",
    "effectAuthorityOwner",
    "effectMaterializationOwners",
}


class AuthorityError(ValueError):
    """A machine authority invariant is missing or changed."""


class DuplicateKeyError(ValueError):
    """JSON contains duplicate object keys and is ambiguous."""


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_pairs)
    except FileNotFoundError as error:
        raise AuthorityError(f"required manifest is missing: {path}") from error
    except (UnicodeDecodeError, json.JSONDecodeError, DuplicateKeyError) as error:
        raise AuthorityError(f"invalid JSON in {path}: {error}") from error
    if not isinstance(value, dict):
        raise AuthorityError(f"manifest root must be an object: {path}")
    return value


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AuthorityError(message)


def required_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    missing = expected - value.keys()
    require(not missing, f"{label}: missing required fields: {', '.join(sorted(missing))}")
    unknown = value.keys() - expected
    require(not unknown, f"{label}: unknown fields are forbidden: {', '.join(sorted(unknown))}")


def validate_schema_companion(schema: dict[str, Any], foundation: dict[str, Any]) -> None:
    require(schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "foundation.schema: only draft 2020-12 is accepted")
    require(schema.get("type") == "object" and schema.get("additionalProperties") is False, "foundation.schema: root must be a closed object")
    require(set(schema.get("required", [])) == ROOT_KEYS, "foundation.schema: required keys differ from canonical manifest")
    properties = schema.get("properties")
    require(isinstance(properties, dict) and set(properties) == ROOT_KEYS, "foundation.schema: properties differ from canonical manifest")
    for key in ROOT_KEYS:
        entry = properties[key]
        require(isinstance(entry, dict) and "const" in entry, f"foundation.schema.{key}: exact const required")
        require(entry["const"] == foundation[key], f"foundation.schema.{key}: companion const differs from manifest")


def validate_foundation(foundation: dict[str, Any]) -> None:
    required_keys(foundation, ROOT_KEYS, "foundation")
    require(foundation["$schema"] == "./runtime-foundation-decision.schema.json", "foundation.$schema: wrong companion schema")
    require(foundation["schemaVersion"] == 2, "foundation: unsupported schemaVersion")
    require(foundation["decisionId"] == "ADR-COP-RUNTIME-002", "foundation.decisionId: wrong Effect-native runtime decision")
    require(foundation["decisionRef"] == "docs/adr/ADR-0023-effect-native-platform.md", "foundation.decisionRef: wrong ADR")
    require(foundation["preserves"] == [
        "docs/adr/ADR-0019-greenfield-node26-and-service-topology.md",
        "docs/adr/ADR-0020-launch-contract-closure.md",
        "docs/adr/ADR-0021-github-operational-authority.md",
        "docs/adr/ADR-0022-ts7-native-toolchain.md",
    ], "foundation.preserves: predecessor ADR inventory changed")

    runtime = foundation["runtime"]
    require(isinstance(runtime, dict), "foundation.runtime: object required")
    require(runtime.get("node") == NODE_VERSION, "foundation.node.node: expected 26.8.1")
    require(runtime.get("npm") == NPM_VERSION, "foundation.node.npm: expected 11.19.0")
    require(runtime.get("corepack") == COREPACK_VERSION, "foundation.node.corepack: expected 0.35.0")
    require(runtime.get("packageManager") == f"pnpm@{PNPM_VERSION}", "foundation.node.packageManager: expected pnpm@11.24.0")

    image = foundation["productionImage"]
    require(isinstance(image, dict), "foundation.productionImage: object required")
    require(image.get("repository") == "docker.io/library/node", "foundation.productionImage.repository: wrong image")
    require(image.get("tag") == "26.8.1-bookworm-slim", "foundation.productionImage.tag: floating or wrong image")
    require(image.get("indexDigest") == IMAGE_INDEX_DIGEST, "foundation.productionImage.indexDigest: unverified image index digest")
    require(image.get("platform") == "linux/amd64", "foundation.productionImage.platform: target platform must be linux/amd64")
    require(image.get("platformManifestDigest") == IMAGE_AMD64_DIGEST, "foundation.productionImage.platformManifestDigest: unverified target digest")
    require(image.get("reference") == f"node:26.8.1-bookworm-slim@{IMAGE_AMD64_DIGEST}", "foundation.productionImage.reference: target digest must be pinned")
    require(foundation["registryVerification"] == {
        "verifiedAt": "2026-09-01",
        "command": "docker buildx imagetools inspect node:26.8.1-bookworm-slim",
        "digestPolicy": "record-index-and-pin-target-platform-manifest",
    }, "foundation.registryVerification: registry evidence changed")

    toolchain = foundation["toolchainDecision"]
    require(isinstance(toolchain, dict), "foundation.toolchainDecision: object required")
    require(toolchain.get("decisionId") == "ADR-COP-TS7-NATIVE-001", "foundation.toolchainDecision.decisionId: ADR-0022 identity changed")
    require(toolchain.get("decisionRef") == "docs/adr/ADR-0022-ts7-native-toolchain.md", "foundation.toolchainDecision.decisionRef: ADR-0022 reference changed")
    require(toolchain.get("typescript") == "typescript@7.0.2", "foundation.toolchainDecision.typescript: TS7 pin changed")
    require(toolchain.get("structuralLinter") == "oxlint@1.80.0", "foundation.toolchainDecision.structuralLinter: pin changed")
    require(toolchain.get("typeAwareLinter") == "oxlint-tsgolint@7.0.2001", "foundation.toolchainDecision.typeAwareLinter: pin changed")
    require(toolchain.get("effectDiagnostics") == "@effect/tsgo@0.39.0", "foundation.toolchainDecision.effectDiagnostics: pin changed")
    require(toolchain.get("compilerLanes") == 1, "foundation.toolchainDecision.compilerLanes: second compiler lane is forbidden")

    platform = foundation["effectPlatform"]
    required_keys(platform, {"authorityRef", "status", "bom", "authorities", "allowedModulePrefixes", "forbiddenModulePrefixes", "cutoverIssues", "businessStartIssue", "upgradePolicy"}, "foundation.effectPlatform")
    require(platform["authorityRef"] == "docs/adr/ADR-0023-effect-native-platform.md", "foundation.effectPlatform.authorityRef: wrong authority")
    require(platform["status"] == "target-until-issue-32-admission", "foundation.effectPlatform.status: cutover status changed")
    require(platform["bom"] == EFFECT_BOM, "foundation.effectPlatform.bom: exact Effect BOM changed")
    require(platform["authorities"] == AUTHORITIES, "foundation.effectPlatform.authorities: dual or unknown technical authority")
    require(platform["allowedModulePrefixes"] == ALLOWED_MODULE_PREFIXES, "foundation.effectPlatform.allowedModulePrefixes: exact allowlist changed")
    require(platform["forbiddenModulePrefixes"] == FORBIDDEN_MODULE_PREFIXES, "foundation.effectPlatform.forbiddenModulePrefixes: forbidden modules changed")
    require(set(ALLOWED_MODULE_PREFIXES).isdisjoint(FORBIDDEN_MODULE_PREFIXES), "foundation.effectPlatform: allowed and forbidden module lists overlap")
    require(platform["cutoverIssues"] == [25, 26, 27, 28, 29, 30, 31, 32], "foundation.effectPlatform.cutoverIssues: linear issue graph changed")
    require(platform["businessStartIssue"] == 4, "foundation.effectPlatform.businessStartIssue: business work must start at #4")
    require(platform["upgradePolicy"] == "separate-platform-only-issue-no-business-changes", "foundation.effectPlatform.upgradePolicy: unsafe dependency upgrade policy")

    require(foundation["preservedArchitecture"] == {
        "deployableRuntimeCount": 15,
        "boundedContexts": ["customer", "catalog", "pricing", "orders", "integration", "realtime"],
        "logicalDatabaseCount": 5,
        "providerEgressRuntime": "aroma-gateway",
        "convergenceOwner": "orders",
        "durableTruth": "postgresql",
        "eventTransport": "kafka-committed-facts-and-wake-up",
        "unsafeProviderMutationRetry": "forbidden",
    }, "foundation.preservedArchitecture: business/data/trust boundary changed")
    require(foundation["prohibitions"] == PROHIBITIONS, "foundation.prohibitions: exact fail-closed prohibition list changed")
    require(foundation["foundationMaterializationOwner"] == "issue-3", "foundation.foundationMaterializationOwner: PR #22 ownership changed")
    require(foundation["effectAuthorityOwner"] == "issue-25", "foundation.effectAuthorityOwner: Effect authority belongs to #25")
    require(foundation["effectMaterializationOwners"] == ["issue-26", "issue-27", "issue-28", "issue-29", "issue-30", "issue-31", "issue-32"], "foundation.effectMaterializationOwners: linear ownership changed")


def legacy_projection(foundation: dict[str, Any]) -> dict[str, Any]:
    return {
        "$schema": "./runtime-foundation-decision.schema.json",
        "schemaVersion": 1,
        "decisionId": "ADR-COP-RUNTIME-001",
        "decisionRef": "docs/adr/ADR-0019-greenfield-node26-and-service-topology.md",
        "runtime": foundation["runtime"],
        "productionImage": foundation["productionImage"],
        "registryVerification": foundation["registryVerification"],
        "toolchainDecision": {
            "decisionId": "ADR-COP-TS7-NATIVE-001",
            "decisionRef": "docs/adr/ADR-0022-ts7-native-toolchain.md",
            "typescript": "typescript@7.0.2",
            "structuralLinter": "oxlint@1.80.0",
            "typeAwareLinter": "oxlint-tsgolint@7.0.2001",
            "openApiGenerator": "@hey-api/openapi-ts@0.99.0",
            "openApiGeneratorPlugin": "@hey-api/typescript",
            "generatorMode": "types-only",
            "compilerLanes": 1,
        },
        "prohibitions": PROHIBITIONS[:8],
        "materializationOwner": "issue-3",
    }


def legacy_schema() -> dict[str, Any]:
    required = ["$schema", "schemaVersion", "decisionId", "decisionRef", "runtime", "productionImage", "registryVerification", "toolchainDecision", "prohibitions", "materializationOwner"]
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": False,
        "required": required,
        "properties": {key: {} for key in required},
    }


def load_legacy_validator(root: Path):
    path = root / "scripts" / "validate-launch-authority.py"
    spec = importlib.util.spec_from_file_location("legacy_launch_authority_validator", path)
    if spec is None or spec.loader is None:
        raise AuthorityError(f"cannot import legacy validator: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def validate_legacy_manifests(root: Path, foundation: dict[str, Any]) -> None:
    legacy = load_legacy_validator(root)
    with tempfile.TemporaryDirectory(prefix="effect-authority-projection-") as temporary:
        temp_root = Path(temporary)
        shutil.copytree(root / "platform", temp_root / "platform")
        (temp_root / "platform" / "runtime-foundation-decision.json").write_text(json.dumps(legacy_projection(foundation), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (temp_root / "platform" / "runtime-foundation-decision.schema.json").write_text(json.dumps(legacy_schema(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        try:
            legacy.validate_root(temp_root)
        except legacy.AuthorityError as error:
            raise AuthorityError(str(error)) from error


def validate_root(root: Path) -> None:
    root = root.resolve()
    foundation = load_json(root / "platform" / "runtime-foundation-decision.json")
    schema = load_json(root / "platform" / "runtime-foundation-decision.schema.json")
    validate_foundation(foundation)
    validate_schema_companion(schema, foundation)
    validate_legacy_manifests(root, foundation)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        validate_root(args.root)
    except (AuthorityError, OSError) as error:
        print(f"effect launch authority: FAIL: {error}", file=sys.stderr)
        return 1
    print("effect launch authority: acceptance passed (v2 Effect platform + preserved v1 topology/trust/data invariants)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
