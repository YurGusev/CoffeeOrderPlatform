#!/usr/bin/env python3
"""Fail-closed semantic checks for the v2 launch authority manifests.

The script intentionally uses only the Python standard library.  JSON Schema
files describe the wire shape; this module checks the invariants which span
the v2 foundation, runtime profile, connectivity and target-layout documents.
It never writes to the repository and can validate a fixture root with
``--root``.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any


RUNTIME_NAMES = (
    "edge-gateway",
    "api-public",
    "api-internal",
    "web",
    "customer-service",
    "catalog-service",
    "catalog-supplier-sync",
    "catalog-activation-worker",
    "pricing-service",
    "orders-service",
    "orders-aroma-preparation",
    "aroma-observer",
    "aroma-convergence",
    "aroma-gateway",
    "realtime-gateway",
)
RUNTIME_SET = frozenset(RUNTIME_NAMES)
ZONES = frozenset({"public-ingress", "public-api-backend", "internal-api", "provider-egress"})

OWNERS = {
    "edge-gateway": "platform",
    "api-public": "platform",
    "api-internal": "platform",
    "web": "frontend",
    "customer-service": "customer",
    "catalog-service": "catalog",
    "catalog-supplier-sync": "catalog",
    "catalog-activation-worker": "catalog",
    "pricing-service": "pricing",
    "orders-service": "orders",
    "orders-aroma-preparation": "orders",
    "aroma-observer": "orders",
    "aroma-convergence": "orders",
    "aroma-gateway": "integration",
    "realtime-gateway": "realtime",
}

M20_REFS = {
    "api-public",
    "api-internal",
    "catalog-supplier-sync",
    "orders-aroma-preparation",
    "aroma-observer",
    "aroma-convergence",
    "aroma-gateway",
    "realtime-gateway",
}

DB_PRINCIPALS = {
    "edge-gateway": None,
    "api-public": None,
    "api-internal": None,
    "web": None,
    "customer-service": "coffee_customer_rw",
    "catalog-service": "coffee_catalog_api_ro",
    "catalog-supplier-sync": "coffee_catalog_import_rw",
    "catalog-activation-worker": "coffee_catalog_activate_rw",
    "pricing-service": "coffee_pricing_rw",
    "orders-service": "coffee_orders_service_rw",
    "orders-aroma-preparation": "coffee_orders_prepare_rw",
    "aroma-observer": "coffee_orders_observer_rw",
    "aroma-convergence": "coffee_orders_convergence_rw",
    "aroma-gateway": "coffee_aroma_gateway_rw",
    "realtime-gateway": None,
}

NETWORK_ZONES = {
    "edge-gateway": "public-ingress",
    "api-public": "public-api-backend",
    "api-internal": "internal-api",
    "web": "public-ingress",
    "customer-service": "internal-api",
    "catalog-service": "internal-api",
    "catalog-supplier-sync": "internal-api",
    "catalog-activation-worker": "internal-api",
    "pricing-service": "internal-api",
    "orders-service": "internal-api",
    "orders-aroma-preparation": "internal-api",
    "aroma-observer": "internal-api",
    "aroma-convergence": "internal-api",
    "aroma-gateway": "provider-egress",
    "realtime-gateway": "public-ingress",
}

SURFACES = {
    "edge-gateway": ["public-edge"],
    "api-public": ["client-v1"],
    "api-internal": ["internal-v1"],
    "web": ["web-assets"],
    "customer-service": ["client-v1-owner", "internal-v1-owner"],
    "catalog-service": ["client-v1-owner", "internal-v1-owner"],
    "catalog-supplier-sync": ["health-only"],
    "catalog-activation-worker": [],
    "pricing-service": ["client-v1-owner", "internal-v1-owner"],
    "orders-service": ["client-v1-owner"],
    "orders-aroma-preparation": ["health-only"],
    "aroma-observer": ["health-only"],
    "aroma-convergence": ["health-only"],
    "aroma-gateway": ["internal-v1-owner", "provider-outbound"],
    "realtime-gateway": ["events"],
}

INTERNAL_ALLOWLIST = (
    ("orders-service", "customer-service", "GET", "/api/internal-v1/customers/{customerRef}/order-input", "getCustomerOrderInput", False),
    ("pricing-service", "catalog-service", "GET", "/api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input", "getCatalogPricingInput", False),
    ("orders-service", "pricing-service", "POST", "/api/internal-v1/pricing/quotes:verify", "verifyPricingQuote", False),
    ("catalog-supplier-sync", "aroma-gateway", "POST", "/api/internal-v1/aroma/catalog-exports", "exportAromaCatalog", False),
    ("aroma-observer", "aroma-gateway", "POST", "/api/internal-v1/aroma/cart-snapshots:read", "readAromaCartSnapshot", False),
    ("aroma-convergence", "aroma-gateway", "POST", "/api/internal-v1/aroma/cart-snapshots:read", "readAromaCartSnapshot", False),
    ("aroma-convergence", "aroma-gateway", "POST", "/api/internal-v1/aroma/cart-lines/{offerRef}:set-quantity", "setAromaCartLineQuantity", True),
    ("aroma-convergence", "aroma-gateway", "POST", "/api/internal-v1/aroma/cart-lines/{offerRef}:remove", "removeAromaCartLine", True),
)


class AuthorityError(ValueError):
    """A machine authority invariant is missing or changed."""


class DuplicateKeyError(ValueError):
    """JSON contains duplicate object keys and is therefore ambiguous."""


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


def required_keys(value: dict[str, Any], keys: set[str], label: str) -> None:
    missing = keys - value.keys()
    require(not missing, f"{label}: missing required fields: {', '.join(sorted(missing))}")
    unknown = value.keys() - keys
    require(not unknown, f"{label}: unknown fields are forbidden: {', '.join(sorted(unknown))}")


def string(value: Any, label: str) -> str:
    require(isinstance(value, str) and bool(value), f"{label}: non-empty string required")
    return value


def exact_list(value: Any, expected: list[Any], label: str) -> None:
    require(isinstance(value, list), f"{label}: array required")
    require(value == expected, f"{label}: exact list changed")


V2_FOUNDATION_KEYS = {
    "$schema", "schemaVersion", "decisionId", "decisionRef", "preserves",
    "runtime", "productionImage", "registryVerification", "toolchainDecision",
    "effectPlatformDecision", "preservedArchitecture", "prohibitions",
    "foundationMaterializationOwner", "effectAuthorityOwner",
    "effectMaterializationOwners",
}
EFFECT_PACKAGES = (
    "effect", "@effect/platform-node", "@effect/platform-browser",
    "@effect/sql-pg", "@effect/opentelemetry", "@effect/atom-react",
    "@effect/vitest", "@effect/tsgo", "pg-copy-streams",
)
EFFECT_IMPORT_AUTHORITY = {
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
EFFECT_ALLOWED_UNSTABLE = [
    "effect/unstable/http/", "effect/unstable/httpapi/",
    "effect/unstable/sql/", "effect/unstable/encoding/",
    "effect/unstable/reactivity/",
]
EFFECT_OFFICIAL_PACKAGES = [
    "@effect/platform-node", "@effect/platform-browser", "@effect/sql-pg",
    "@effect/opentelemetry", "@effect/atom-react", "@effect/vitest",
]
EFFECT_FORBIDDEN_UNSTABLE = [
    "effect/unstable/rpc/", "effect/unstable/workflow/",
    "effect/unstable/cluster/", "effect/unstable/persistence/",
    "effect/unstable/eventlog/", "effect/unstable/ai/",
    "effect/unstable/cli/", "effect/unstable/workers/",
]
V2_PROHIBITIONS = [
    "node-24", "floating-image-tag", "placeholder-digest",
    "typescript-5-or-6", "second-typescript-compiler", "nightly-toolchain-pin",
    "compiler-api", "custom-transformer", "dual-runtime-stack",
    "shared-platform-live-across-owners", "effect-wrapper-framework", "effect-rpc",
    "effect-workflow", "effect-persistence", "effect-eventlog", "effect-cluster",
    "unsafe-aroma-mutation-retry",
]
VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+)+(?:-[0-9A-Za-z.-]+)?$")
DELIVERY_GRAPH = "#3 → #48 → #49 → #50 → #51 → #52 → #53 → #54 → #55 → #4"


def validate_schema_artifacts(platform: Path) -> None:
    schemas = {
        "runtime-foundation-decision.schema.json": V2_FOUNDATION_KEYS,
        "launch-v1-runtime-profile.schema.json": {"$schema", "schemaVersion", "authority", "exactDeployableRuntimeCount", "runtimes", "specialRoles", "routeMounts", "surfaceIsolation", "internalOperationAllowlist", "delegation", "transportIdentity", "catalogIdentity", "ordersAuthority"},
        "launch-v1-connectivity-policy.schema.json": {"$schema", "schemaVersion", "authorityRef", "logicalZones", "dockerNetworks", "forbiddenNetworks", "runtimePolicies", "globalDenyAssertions"},
        "target-layout.schema.json": {"$schema", "schemaVersion", "authorityRef", "workspaceMaterializationOwner", "runtimeRoots", "plannedRoots", "technicalRoots", "forbiddenRoots", "filesystemCreationAuthorized"},
    }
    for filename, expected_required in schemas.items():
        schema = load_json(platform / filename)
        require(schema["$schema"] == "https://json-schema.org/draft/2020-12/schema", f"{filename}: only JSON Schema draft 2020-12 is accepted")
        require(schema.get("type") == "object" and schema.get("additionalProperties") is False, f"{filename}: root must be a closed object schema")
        require(set(schema.get("required", [])) == expected_required, f"{filename}: root required set does not match its manifest")


def registry_value(registry: dict[str, Any], reference: Any, label: str) -> Any:
    prefix = "config/toolchain-versions.json#/"
    require(isinstance(reference, str) and reference.startswith(prefix), f"{label}: canonical registry reference required")
    key = reference[len(prefix):]
    require(key in registry and isinstance(registry[key], (str, int)), f"{label}: registry reference target is missing")
    return registry[key]


def has_numeric_version_const(value: Any) -> bool:
    if isinstance(value, dict):
        return any((key == "const" and isinstance(item, str) and VERSION_RE.fullmatch(item)) or has_numeric_version_const(item) for key, item in value.items())
    if isinstance(value, list):
        return any(has_numeric_version_const(item) for item in value)
    return False


def validate_v2_registry(registry: dict[str, Any], schema: dict[str, Any], decision_ref: str) -> None:
    require(registry.get("$schema") == "./toolchain-versions.schema.json", "toolchain registry: wrong companion schema")
    require(registry.get("schemaVersion") == 2, "toolchain registry: schemaVersion must be 2")
    target = registry.get("effectTarget")
    require(isinstance(target, dict), "toolchain registry.effectTarget: object required")
    required_keys(target, {"authorityRef", "materializationOwner", "generatedOpenApi", "packages"}, "toolchain registry.effectTarget")
    require(target["authorityRef"] == decision_ref, "toolchain registry.effectTarget.authorityRef: ADR reference changed")
    require(target["materializationOwner"] == "issue-49", "toolchain registry.effectTarget.materializationOwner: owner changed")
    require(target["generatedOpenApi"] == "3.1.0", "toolchain registry.effectTarget.generatedOpenApi: OpenAPI 3.1 is required")
    packages = target["packages"]
    require(isinstance(packages, dict) and tuple(packages) == EFFECT_PACKAGES, "toolchain registry.effectTarget.packages: exact Effect package set changed")
    require(all(isinstance(value, str) and VERSION_RE.fullmatch(value) for value in packages.values()), "toolchain registry.effectTarget.packages: exact semver values required")
    require(len({packages[name] for name in EFFECT_PACKAGES[:-2]}) == 1, "toolchain registry.effectTarget.packages: Effect packages must share one release version")
    require(schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "toolchain schema: draft 2020-12 required")
    require(schema.get("type") == "object" and schema.get("additionalProperties") is False, "toolchain schema: closed object required")
    require(not has_numeric_version_const(schema), "toolchain schema: exact version const duplicates the registry")


def validate_foundation_v2(doc: dict[str, Any], registry: dict[str, Any]) -> None:
    required_keys(doc, V2_FOUNDATION_KEYS, "foundation")
    require(doc["$schema"] == "./runtime-foundation-decision.schema.json", "foundation.$schema: wrong companion schema")
    require(doc["schemaVersion"] == 2, "foundation: unsupported schemaVersion")
    require(doc["decisionId"] == "ADR-COP-RUNTIME-002", "foundation.decisionId: wrong runtime decision")
    require(doc["decisionRef"] == "docs/adr/ADR-0024-effect-native-platform.md", "foundation.decisionRef: wrong ADR")
    require(doc["preserves"] == [
        "docs/adr/ADR-0019-greenfield-node26-and-service-topology.md",
        "docs/adr/ADR-0020-launch-contract-closure.md",
        "docs/adr/ADR-0021-github-operational-authority.md",
        "docs/adr/ADR-0022-ts7-native-toolchain.md",
    ], "foundation.preserves: predecessor ADR inventory changed")
    runtime = doc["runtime"]
    require(isinstance(runtime, dict), "foundation.runtime: object required")
    if "node" in runtime:
        require(False, "foundation.node.node: legacy numeric field is forbidden; use nodeRef")
    if "packageManager" in runtime:
        require(False, "foundation.node.packageManager: legacy numeric field is forbidden; use packageManagerRef")
    required_keys(runtime, {"nodeRef", "npmRef", "corepackRef", "packageManagerRef"}, "foundation.runtime")
    expected_refs = {
        "nodeRef": "config/toolchain-versions.json#/node",
        "npmRef": "config/toolchain-versions.json#/npm",
        "corepackRef": "config/toolchain-versions.json#/corepack",
        "packageManagerRef": "config/toolchain-versions.json#/pnpm",
    }
    for key, reference in expected_refs.items():
        require(runtime[key] == reference, f"foundation.runtime.{key}: canonical registry reference changed")
        registry_value(registry, runtime[key], f"foundation.{key}")
    image = doc["productionImage"]
    require(isinstance(image, dict), "foundation.productionImage: object required")
    if "tag" in image:
        require(False, "foundation.productionImage.tag: legacy numeric field is forbidden; use referenceRef")
    required_keys(image, {"referenceRef", "platform"}, "foundation.productionImage")
    require(image["referenceRef"] == "config/toolchain-versions.json#/nodeImage", "foundation.productionImage.referenceRef: node image registry reference changed")
    require(image["platform"] == "linux/amd64", "foundation.productionImage.platform: target platform changed")
    require(doc["registryVerification"] == {
        "verifiedAt": "2026-09-01",
        "command": "docker buildx imagetools inspect",
        "digestPolicy": "record-index-and-pin-target-platform-manifest",
    }, "foundation.registryVerification: registry evidence changed")
    toolchain = doc["toolchainDecision"]
    require(isinstance(toolchain, dict), "foundation.toolchainDecision: object required")
    if "compilerLanes" in toolchain and toolchain["compilerLanes"] != 1:
        require(False, "foundation.toolchainDecision.compilerLanes: second compiler lane is forbidden")
    required_keys(toolchain, {"decisionId", "decisionRef", "contractSource", "generatedOpenApi", "compilerLanes"}, "foundation.toolchainDecision")
    require(toolchain["decisionId"] == "ADR-COP-TS7-NATIVE-001", "foundation.toolchainDecision.decisionId: ADR-0022 identity changed")
    require(toolchain["decisionRef"] == "docs/adr/ADR-0022-ts7-native-toolchain.md", "foundation.toolchainDecision.decisionRef: ADR-0022 reference changed")
    require(toolchain["contractSource"] == "effect-schema-httpapi", "foundation.toolchainDecision.contractSource: Effect Schema/HttpApi required")
    require(toolchain["generatedOpenApi"] == "3.1.0", "foundation.toolchainDecision.generatedOpenApi: OpenAPI 3.1 is required")
    for field in ("openApiGenerator", "openApiGeneratorPlugin", "generatorMode"):
        require(field not in toolchain, f"foundation.toolchainDecision.{field}: removed field is forbidden")


    effect = doc["effectPlatformDecision"]
    required_keys(effect, {"decisionId", "decisionRef", "bomRef", "packageAuthority", "importAuthority", "modulePolicy", "materializationOwner", "upgradePolicy"}, "foundation.effectPlatformDecision")
    require(effect["decisionId"] == "ADR-COP-EFFECT-NATIVE-001", "foundation.effectPlatformDecision.decisionId: wrong Effect decision")
    require(effect["decisionRef"] == doc["decisionRef"], "foundation.effectPlatformDecision.decisionRef: ADR reference changed")
    require(effect["bomRef"] == "config/toolchain-versions.json", "foundation.effectPlatformDecision.bomRef: canonical BOM ref required")
    require(effect["packageAuthority"] == list(EFFECT_PACKAGES), "foundation.effectPlatformDecision.packageAuthority: package set changed")
    require(effect["importAuthority"] == EFFECT_IMPORT_AUTHORITY, "foundation.effectPlatformDecision.importAuthority: Effect authority changed")
    require(effect["modulePolicy"] == {
        "stablePackageRoot": "effect", "unstableDefault": "deny",
        "allowedUnstablePrefixes": EFFECT_ALLOWED_UNSTABLE,
        "allowedOfficialPackages": EFFECT_OFFICIAL_PACKAGES,
        "explicitlyForbiddenUnstablePrefixes": EFFECT_FORBIDDEN_UNSTABLE,
    }, "foundation.effectPlatformDecision.modulePolicy: unstable module policy changed")
    require(effect["materializationOwner"] == "issue-49", "foundation.effectPlatformDecision.materializationOwner: next owner must be issue-49")
    require(effect["upgradePolicy"] == "separate-platform-only-issue-no-business-changes", "foundation.effectPlatformDecision.upgradePolicy: unsafe upgrade policy")
    require(doc["preservedArchitecture"] == {
        "deployableRuntimeCount": 15,
        "boundedContexts": ["customer", "catalog", "pricing", "orders", "integration", "realtime"],
        "logicalDatabaseCount": 5,
        "providerEgressRuntime": "aroma-gateway",
        "convergenceOwner": "orders",
        "durableTruth": "postgresql",
        "eventTransport": "kafka-committed-facts-and-wake-up",
        "unsafeProviderMutationRetry": "forbidden",
    }, "foundation.preservedArchitecture: business/data/trust boundary changed")
    require(doc["prohibitions"] == V2_PROHIBITIONS, "foundation.prohibitions: fail-closed prohibition list changed")
    require(doc["foundationMaterializationOwner"] == "issue-3", "foundation.foundationMaterializationOwner: issue #3 ownership changed")
    require(doc["effectAuthorityOwner"] == "issue-48", "foundation.effectAuthorityOwner: Effect authority belongs to #48")
    require(doc["effectMaterializationOwners"] == ["issue-49", "issue-50", "issue-51", "issue-52", "issue-53", "issue-54", "issue-55"], "foundation.effectMaterializationOwners: delivery line changed")


def validate_delivery_graph(root: Path) -> None:
    path = root / "docs" / "launch" / "13_DELIVERY_DEPENDENCY_GRAPH.md"
    try:
        document = re.sub(r"\s+", " ", path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError) as error:
        raise AuthorityError(f"delivery graph: cannot read {path}: {error}") from error
    require(DELIVERY_GRAPH in document, "delivery graph: canonical #3→#48→#55→#4 sequence is missing")
    require("#49 получает `status:ready` только после merge #48" in document, "delivery graph: #49 readiness gate changed")
    require("#50–#55 остаются `status:blocked`" in document, "delivery graph: blocked downstream gate changed")
    for line in ("#5..#12 + #16..#18 → #13 Launch gates", "#10 + #16 + #18 + #8 → #11 AROMA convergence", "#8 + #9 + #11 → #12 Realtime"):
        require(line in document, f"delivery graph: business edge changed: {line}")


def runtime_entries(profile: dict[str, Any]) -> list[dict[str, Any]]:
    entries = profile["runtimes"]
    require(isinstance(entries, list), "profile.runtimes: array required")
    require(all(isinstance(item, dict) for item in entries), "profile.runtimes: every entry must be an object")
    return entries


def validate_runtime_profile(profile: dict[str, Any]) -> None:
    required_keys(profile, {"$schema", "schemaVersion", "authority", "exactDeployableRuntimeCount", "runtimes", "specialRoles", "routeMounts", "surfaceIsolation", "internalOperationAllowlist", "delegation", "transportIdentity", "catalogIdentity", "ordersAuthority"}, "profile")
    require(profile["$schema"] == "./launch-v1-runtime-profile.schema.json", "profile.$schema: wrong companion schema")
    require(profile["schemaVersion"] == 1, "profile: unsupported schemaVersion")
    require(profile["authority"] == {
        "runtimeDecisionRef": "docs/adr/ADR-0019-greenfield-node26-and-service-topology.md",
        "contractDecisionRef": "docs/adr/ADR-0020-launch-contract-closure.md",
        "identityRef": "docs/launch/24_SERVICE_IDENTITY_AND_DELEGATION.md",
        "runtimeCatalogRef": "docs/launch/10_RUNTIME_CATALOG.md",
    }, "profile.authority: decision references changed")
    require(profile["exactDeployableRuntimeCount"] == 15, "profile.exactDeployableRuntimeCount: expected 15")

    entries = runtime_entries(profile)
    names = [entry.get("name") for entry in entries]
    require(len(entries) == 15 and set(names) == RUNTIME_SET and len(set(names)) == 15, "profile.runtimes: exact 15-runtime inventory required")

    for entry in entries:
        name = string(entry.get("name"), "profile.runtime.name")
        required_keys(entry, {"name", "owner", "m20Traceability", "networkZone", "dbPrincipal", "httpSurfaces", "secretRefs", "implemented"}, f"profile.runtimes.{name}")
        require(entry["owner"] == OWNERS[name], f"profile.runtimes.{name}.owner: owner changed")
        trace = entry["m20Traceability"]
        require(isinstance(trace, dict), f"profile.runtimes.{name}.m20Traceability: object required")
        required_keys(trace, {"classification", "roleRef"}, f"profile.runtimes.{name}.m20Traceability")
        if trace["classification"] == "launch-v1-only":
            require(trace["roleRef"] is None and name not in M20_REFS, f"profile.runtimes.{name}: exact M20 role reference is required")
        else:
            require(trace["classification"] == "exact-role-ref" and name in M20_REFS and trace["roleRef"] == name, f"profile.runtimes.{name}.m20Traceability: inferred or wrong reference")
        require(entry["networkZone"] == NETWORK_ZONES[name] and entry["networkZone"] in ZONES, f"profile.runtimes.{name}.networkZone: trust zone changed")
        require(entry["dbPrincipal"] == DB_PRINCIPALS[name], f"profile.runtimes.{name}.dbPrincipal: owner DB principal changed")
        exact_list(entry["httpSurfaces"], SURFACES[name], f"profile.runtimes.{name}.httpSurfaces")
        require(isinstance(entry["secretRefs"], list) and all(isinstance(ref, str) and ref for ref in entry["secretRefs"]), f"profile.runtimes.{name}.secretRefs: non-empty refs required")
        require(entry["implemented"] is False, f"profile.runtimes.{name}.implemented: authority profile cannot claim implementation")

        if name in {"edge-gateway", "api-public", "api-internal"}:
            refs = " ".join(entry["secretRefs"]).lower()
            for forbidden in ("postgres", "kafka", "aroma", "provider"):
                require(forbidden not in refs, f"profile.runtimes.{name}.secretRefs: API roots cannot receive {forbidden} secrets")

    identity = profile["transportIdentity"]
    require(identity == {
        "algorithm": "Ed25519",
        "sanTemplate": "spiffe://coffee-platform/{environment}/{runtime}",
        "certificateTtlHours": 24,
        "rotateBeforeExpiryHours": 6,
        "trustBundleOverlapHours": 12,
        "trustBundleRef": "platform.security.serviceTrustBundles",
        "privateMaterialDelivery": "per-runtime-scoped-tmpfs",
        "activePreviousTrustRequired": True,
        "caPrivateKeyRuntimeAccess": False,
        "composeRotation": "config-bootstrap-plus-restart",
        "revocationMode": "config-bootstrap-reissue-trust-update-restart",
        "invalidIdentityReadinessStatus": 503,
        "identities": list(RUNTIME_NAMES),
    }, "profile.transportIdentity: per-runtime identity lifecycle changed")

    special = profile["specialRoles"]
    require(isinstance(special, dict), "profile.specialRoles: object required")
    required_keys(special, {"api-agent", "config-bootstrap"}, "profile.specialRoles")
    agent = special["api-agent"]
    require(agent == {
        "classification": "deployable-runtime-role",
        "state": "planned",
        "implemented": False,
        "deployedInFirstLaunch": False,
        "composeEntryAllowed": False,
    }, "profile.apiAgent: api-agent must remain planned and absent from Compose")
    bootstrap = special["config-bootstrap"]
    require(bootstrap == {
        "classification": "trusted-initialization-provisioning-role",
        "lifecycle": "init-only",
        "longRunning": False,
        "listenerAllowed": False,
        "replicasAllowed": False,
    }, "profile.configBootstrap: init-only role changed")

    validate_routes(profile["routeMounts"], profile["surfaceIsolation"])
    validate_allowlist(profile["internalOperationAllowlist"])
    validate_delegation(profile["delegation"])
    validate_domain_contracts(profile["catalogIdentity"], profile["ordersAuthority"])


def validate_routes(route_mounts: Any, isolation: Any) -> None:
    expected_routes = [
        {"source": "edge-gateway", "method": "GET", "path": "/", "target": "web", "targetPort": 3000},
        {"source": "edge-gateway", "method": "GET", "path": "/assets/**", "target": "web", "targetPort": 3000},
        {"source": "edge-gateway", "method": "ANY", "path": "/api/client-v1/**", "target": "api-public", "targetPort": 4050},
        {"source": "edge-gateway", "method": "GET", "path": "/events", "target": "realtime-gateway", "targetPort": 4401},
    ]
    require(route_mounts == expected_routes, "profile.routeMounts: public route mounting changed")
    require(isolation == {
        "api-public": ["client-v1"],
        "api-internal": ["internal-v1"],
        "edgeDirectOwnerRoutingAllowed": False,
        "ownerHostPortPublishingAllowed": False,
        "webHostPortPublishingAllowed": False,
    }, "profile.surfaceIsolation: trust surface isolation changed")
    for item in route_mounts:
        require(item["target"] in {"web", "api-public", "realtime-gateway"}, "profile.routeMounts: Edge-to-owner route is forbidden")


def validate_allowlist(value: Any) -> None:
    require(isinstance(value, list), "profile.internalAllowlist: array required")
    actual = []
    for item in value:
        require(isinstance(item, dict), "profile.internalAllowlist: object entries required")
        required_keys(item, {"originalCaller", "target", "method", "path", "operationId", "mutation"}, "profile.internalAllowlist entry")
        actual.append((item["originalCaller"], item["target"], item["method"], item["path"], item["operationId"], item["mutation"]))
    require(tuple(actual) == INTERNAL_ALLOWLIST, "profile.internalOperationAllowlist: exact caller/target/operation allowlist changed")
    require(sum(row[5] for row in actual) == 2, "profile.internalAllowlist: exactly two convergence mutations required")


def validate_delegation(value: Any) -> None:
    require(isinstance(value, dict), "profile.delegation: object required")
    required_keys(value, {"publicActor", "internalService"}, "profile.delegation")
    public = value["publicActor"]
    require(public == {
        "edgeAssertionIssuer": "edge-gateway",
        "edgeAssertionAudience": "api-public",
        "ownerAssertionIssuer": "api-public",
        "transportCallerAtOwner": "api-public",
        "signingKeyRef": "security.apiPublicDelegationSigningPrivateKey",
        "transportKeyReuseAllowed": False,
        "requiredClaims": ["iss", "aud", "originalIssuer", "sub", "permissions", "operationId", "correlationId", "traceparent", "iat", "exp", "jti", "kid"],
        "edgeAssertionMaxTtlSeconds": 60,
        "clockSkewSeconds": 5,
    }, "profile.delegation.publicActor: actor assertion contract changed")
    internal = value["internalService"]
    require(internal == {
        "issuer": "api-internal",
        "transportCallerAtTarget": "api-internal",
        "signingKeyRef": "security.apiInternalDelegationSigningPrivateKey",
        "requiredClaims": ["iss", "aud", "originalCaller", "operationId", "correlationId", "traceparent", "iat", "exp", "jti", "kid"],
        "maxTtlRule": "remaining-request-deadline-plus-5s-skew",
        "gatewayMutationOriginalCaller": "aroma-convergence",
    }, "profile.delegation.internal: internal delegation contract changed")


def validate_domain_contracts(catalog: Any, orders: Any) -> None:
    require(catalog == {
        "algorithm": "hmac-sha256-v1",
        "secretRef": "aroma.catalogIdentityKeyV1",
        "input": ["supplierProductRef", "supplierVariantRef", "normalizedPack", "normalizedUnit"],
        "collisionPolicy": "quarantine-generation",
        "rotationPolicy": "versioned-key-new-snapshots-only-existing-identities-remain-stable",
    }, "profile.catalogIdentity: HMAC identity contract changed")
    require(orders == {
        "confirmedOfferPolicy": "frozen-no-automatic-remap",
        "blockers": ["MAPPING_CHANGED", "MAPPING_MISSING", "MAPPING_STOPPED", "PRODUCT_UNAVAILABLE"],
        "projectionRepositoryOwner": "orders-service",
        "projectionRepositoryCount": 1,
        "ownerVersionSource": "OrderCard.projectionVersion",
        "commandVersionSource": "Order.version",
        "versionsIndependent": True,
        "desiredObservedComparison": "semantic-state-only-never-revision-equality",
        "terminalInSyncProof": "observed matches desired for frozen offers and no unresolved blocker or unknown outcome",
    }, "profile.ordersAuthority: version/projection/frozen-offer contract changed")


def validate_connectivity(policy: dict[str, Any]) -> None:
    required_keys(policy, {"$schema", "schemaVersion", "authorityRef", "logicalZones", "dockerNetworks", "forbiddenNetworks", "runtimePolicies", "globalDenyAssertions"}, "connectivity")
    require(policy["$schema"] == "./launch-v1-connectivity-policy.schema.json", "connectivity.$schema: wrong companion schema")
    require(policy["schemaVersion"] == 1 and policy["authorityRef"] == "docs/launch/23_RUNTIME_CONFIGURATION_MATRIX.md", "connectivity: authority reference changed")
    exact_list(policy["logicalZones"], ["public-ingress", "public-api-backend", "internal-api", "provider-egress"], "connectivity.logicalZones")
    require(policy["forbiddenNetworks"] == ["coffee_network"], "connectivity.forbiddenNetworks: legacy coffee_network must remain forbidden")
    expected_networks = {
        "coffee_host_ingress": (False, False),
        "coffee_public_ingress": (True, False),
        "coffee_edge_backend": (True, False),
        "coffee_public_api_backend": (True, False),
        "coffee_internal_api": (True, False),
        "coffee_postgres_data": (True, True),
        "coffee_kafka_event": (True, False),
        "coffee_provider_egress": (False, False),
    }
    networks = policy["dockerNetworks"]
    require(isinstance(networks, list) and {item.get("name") for item in networks if isinstance(item, dict)} == set(expected_networks), "connectivity.dockerNetworks: exact physical network set required")
    for item in networks:
        require(isinstance(item, dict), "connectivity.dockerNetworks: object entries required")
        required_keys(item, {"name", "internal", "external"}, "connectivity.dockerNetwork")
        require((item["internal"], item["external"]) == expected_networks[item["name"]], f"connectivity.dockerNetworks.{item['name']}: network flags changed")

    expected_attachments = {
        "edge-gateway": ["coffee_host_ingress", "coffee_public_ingress", "coffee_edge_backend"],
        "api-public": ["coffee_edge_backend", "coffee_public_api_backend"],
        "api-internal": ["coffee_internal_api"],
        "web": ["coffee_public_ingress"],
        "customer-service": ["coffee_public_api_backend", "coffee_internal_api", "coffee_postgres_data"],
        "catalog-service": ["coffee_public_api_backend", "coffee_internal_api", "coffee_postgres_data"],
        "catalog-supplier-sync": ["coffee_internal_api", "coffee_postgres_data"],
        "catalog-activation-worker": ["coffee_postgres_data", "coffee_kafka_event"],
        "pricing-service": ["coffee_public_api_backend", "coffee_internal_api", "coffee_postgres_data"],
        "orders-service": ["coffee_public_api_backend", "coffee_internal_api", "coffee_postgres_data", "coffee_kafka_event"],
        "orders-aroma-preparation": ["coffee_postgres_data", "coffee_kafka_event"],
        "aroma-observer": ["coffee_internal_api", "coffee_postgres_data", "coffee_kafka_event"],
        "aroma-convergence": ["coffee_internal_api", "coffee_postgres_data", "coffee_kafka_event"],
        "aroma-gateway": ["coffee_internal_api", "coffee_postgres_data", "coffee_provider_egress"],
        "realtime-gateway": ["coffee_edge_backend", "coffee_kafka_event"],
    }
    policies = policy["runtimePolicies"]
    require(isinstance(policies, list) and len(policies) == 15, "connectivity.runtimePolicies: exact 15-runtime set required")
    by_runtime = {}
    for item in policies:
        require(isinstance(item, dict), "connectivity.runtimePolicies: object entries required")
        required_keys(item, {"runtime", "dockerNetworks", "hostPortPolicy", "allowedHostPorts", "allowedExternalEgress", "denyAssertions"}, "connectivity.runtimePolicy")
        name = string(item["runtime"], "connectivity.runtimePolicy.runtime")
        require(name not in by_runtime, f"connectivity.runtimePolicies: duplicate {name}")
        by_runtime[name] = item
    require(set(by_runtime) == RUNTIME_SET, "connectivity.runtimePolicies: exact runtime set required")
    for name in RUNTIME_NAMES:
        item = by_runtime[name]
        require(item["dockerNetworks"] == expected_attachments[name], f"connectivity.runtimePolicies.{name}.dockerNetworks: attachments changed")
        host_policy = item["hostPortPolicy"]
        require(host_policy == {"default": "deny", "allowedPublishedHostPorts": ([4000] if name == "edge-gateway" else [])}, f"connectivity.runtimePolicies.{name}.hostPortPolicy: default-deny or published port changed")
        require(isinstance(item["allowedHostPorts"], list) and all(isinstance(port, str) for port in item["allowedHostPorts"]), f"connectivity.runtimePolicies.{name}.allowedHostPorts: invalid allowlist")
        require(isinstance(item["allowedExternalEgress"], list) and all(isinstance(host, str) for host in item["allowedExternalEgress"]), f"connectivity.runtimePolicies.{name}.allowedExternalEgress: invalid egress")
        if name == "aroma-gateway":
            require(item["allowedExternalEgress"] == ["${aroma.origin.host}:443"], "connectivity.runtimePolicies.aroma-gateway: exact provider egress required")
            require("coffee_provider_egress" in item["dockerNetworks"], "connectivity.runtimePolicies.aroma-gateway: provider network missing")
        else:
            require(item["allowedExternalEgress"] == [], f"connectivity.runtimePolicies.{name}: provider egress is Gateway-only")
        require(len(item["denyAssertions"]) >= 3, f"connectivity.runtimePolicies.{name}.denyAssertions: negative boundary assertions required")
    globals_ = policy["globalDenyAssertions"]
    require(isinstance(globals_, list) and {"unknown-runtime-denied", "unknown-network-denied", "unknown-host-port-denied", "dns-and-resolved-ip-must-match-allowlist", "docker-network-does-not-grant-application-egress", "no-launch-runtime-on-coffee_network", "provider-origin-only-from-aroma-gateway"} <= set(globals_), "connectivity.globalDenyAssertions: fail-closed rules missing")


def validate_target_layout(layout: dict[str, Any]) -> None:
    required_keys(layout, {"$schema", "schemaVersion", "authorityRef", "workspaceMaterializationOwner", "runtimeRoots", "plannedRoots", "technicalRoots", "forbiddenRoots", "filesystemCreationAuthorized"}, "target-layout")
    require(layout["$schema"] == "./target-layout.schema.json", "target-layout.$schema: wrong companion schema")
    require(layout["schemaVersion"] == 1 and layout["authorityRef"] == "docs/adr/ADR-0019-greenfield-node26-and-service-topology.md", "target-layout: identity changed")
    require(layout["workspaceMaterializationOwner"] == "issue-3", "target-layout.workspaceMaterializationOwner: workspace belongs to issue #3")
    entries = layout["runtimeRoots"]
    require(isinstance(entries, list) and len(entries) == 15, "target-layout.runtimeRoots: exact 15 runtime paths required")
    by_name = {}
    for item in entries:
        require(isinstance(item, dict), "target-layout.runtimeRoots: object entries required")
        required_keys(item, {"name", "path", "classification", "state", "implemented"}, "target-layout.runtimeRoot")
        name = string(item["name"], "target-layout.runtimeRoot.name")
        require(name not in by_name, f"target-layout.runtimeRoots: duplicate {name}")
        by_name[name] = item
    require(set(by_name) == RUNTIME_SET, "target-layout.runtimeRoots: exact runtime set required")
    for name in RUNTIME_NAMES:
        item = by_name[name]
        require(item == {"name": name, "path": f"apps/{name}", "classification": "deployable-runtime", "state": "planned", "implemented": False}, f"target-layout.runtimeRoots.{name}: planned target path changed")
    require(layout["plannedRoots"] == [
        {"name": "api-agent", "path": "apps/api-agent", "classification": "deployable-runtime-role", "state": "planned", "implemented": False, "deployedInFirstLaunch": False},
        {"name": "config-bootstrap", "path": "tools/config-bootstrap", "classification": "trusted-initialization-provisioning-role", "state": "planned", "implemented": False, "deployedInFirstLaunch": True},
    ], "target-layout.plannedRoots: api-agent/config-bootstrap lifecycle changed")
    require(layout["technicalRoots"] == ["packages/contracts", "packages/generated", "packages/platform-config", "packages/platform-observability", "packages/platform-security"], "target-layout.technicalRoots: package boundary changed")
    require(layout["forbiddenRoots"] == ["platform/apps", "packages/domain", "packages/models", "packages/shared-business"], "target-layout.forbiddenRoots: forbidden legacy/shared roots changed")
    require(layout["filesystemCreationAuthorized"] is False, "target-layout.filesystemCreationAuthorized: authority may not create runtime roots")


def validate_root(root: Path) -> None:
    platform = root / "platform"
    foundation = load_json(platform / "runtime-foundation-decision.json")
    require(foundation.get("schemaVersion") == 2, "foundation: schemaVersion 2 is required")
    validate_schema_artifacts(platform)
    schema = load_json(platform / "runtime-foundation-decision.schema.json")
    registry = load_json(root / "config" / "toolchain-versions.json")
    registry_schema = load_json(root / "config" / "toolchain-versions.schema.json")
    validate_v2_registry(registry, registry_schema, foundation.get("decisionRef", ""))
    require(schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "foundation schema: draft 2020-12 required")
    require(schema.get("type") == "object" and schema.get("additionalProperties") is False, "foundation schema: closed object required")
    require(set(schema.get("required", [])) == V2_FOUNDATION_KEYS and set(schema.get("properties", {})) == V2_FOUNDATION_KEYS, "foundation schema: v2 root shape changed")
    validate_foundation_v2(foundation, registry)
    validate_delivery_graph(root)
    profile = load_json(platform / "launch-v1-runtime-profile.json")
    connectivity = load_json(platform / "launch-v1-connectivity-policy.json")
    layout = load_json(platform / "target-layout.json")
    validate_runtime_profile(profile)
    validate_connectivity(connectivity)
    validate_target_layout(layout)

    profile_names = {entry["name"] for entry in runtime_entries(profile)}
    layout_names = {entry["name"] for entry in layout["runtimeRoots"]}
    require(profile_names == layout_names == RUNTIME_SET, "cross-manifest: runtime inventories differ")
    for name in RUNTIME_NAMES:
        profile_entry = next(entry for entry in runtime_entries(profile) if entry["name"] == name)
        require(profile_entry["implemented"] is False, f"cross-manifest: {name} is implemented before #19")
    require(profile["specialRoles"]["api-agent"]["implemented"] is False and not profile["specialRoles"]["api-agent"]["composeEntryAllowed"], "cross-manifest: api-agent must not be deployed")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="repository or fixture root")
    args = parser.parse_args(argv)
    try:
        validate_root(args.root.resolve())
    except (AuthorityError, OSError) as error:
        print(f"launch authority: FAIL: {error}", file=sys.stderr)
        return 1
    print("launch authority: positive acceptance passed (foundation/topology/connectivity/layout/security/domain)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
