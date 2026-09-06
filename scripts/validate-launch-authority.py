#!/usr/bin/env python3
"""Fail-closed semantic checks for the launch-v1 authority manifests.

The script intentionally uses only the Python standard library.  JSON Schema
files describe the wire shape; this module checks the invariants which span
the foundation, runtime profile, connectivity and target-layout documents.
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


NODE_VERSION = "26.8.1"
NPM_VERSION = "11.19.0"
COREPACK_VERSION = "0.35.0"
PNPM_VERSION = "11.24.0"
IMAGE_INDEX_DIGEST = "sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e"
IMAGE_AMD64_DIGEST = "sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae"

TS7_DECISION = "ADR-COP-TS7-NATIVE-001"
TS7_PINS = {
    "typescript": "7.0.2",
    "oxlint": "1.80.0",
    "oxlint-tsgolint": "7.0.2001",
    "@hey-api/openapi-ts": "0.0.0-next-20260824173136",
}

FOUNDATION_PROHIBITIONS = [
    "node-24",
    "floating-image-tag",
    "placeholder-digest",
    "typescript-5-or-6",
    "second-typescript-compiler",
    "nightly-toolchain-pin",
    "compiler-api",
    "custom-transformer",
]

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


def validate_schema_artifacts(platform: Path) -> None:
    schemas = {
        "runtime-foundation-decision.schema.json": {"$schema", "schemaVersion", "decisionId", "decisionRef", "runtime", "productionImage", "registryVerification", "toolchainDecision", "prohibitions", "materializationOwner"},
        "launch-v1-runtime-profile.schema.json": {"$schema", "schemaVersion", "authority", "exactDeployableRuntimeCount", "runtimes", "specialRoles", "routeMounts", "surfaceIsolation", "internalOperationAllowlist", "delegation", "transportIdentity", "catalogIdentity", "ordersAuthority"},
        "launch-v1-connectivity-policy.schema.json": {"$schema", "schemaVersion", "authorityRef", "logicalZones", "dockerNetworks", "forbiddenNetworks", "runtimePolicies", "globalDenyAssertions"},
        "target-layout.schema.json": {"$schema", "schemaVersion", "authorityRef", "workspaceMaterializationOwner", "runtimeRoots", "plannedRoots", "technicalRoots", "forbiddenRoots", "filesystemCreationAuthorized"},
    }
    for filename, expected_required in schemas.items():
        schema = load_json(platform / filename)
        require(schema["$schema"] == "https://json-schema.org/draft/2020-12/schema", f"{filename}: only JSON Schema draft 2020-12 is accepted")
        require(schema.get("type") == "object" and schema.get("additionalProperties") is False, f"{filename}: root must be a closed object schema")
        require(set(schema.get("required", [])) == expected_required, f"{filename}: root required set does not match its manifest")


def validate_foundation(doc: dict[str, Any]) -> None:
    required_keys(doc, {"$schema", "schemaVersion", "decisionId", "decisionRef", "runtime", "productionImage", "registryVerification", "toolchainDecision", "prohibitions", "materializationOwner"}, "foundation")
    require(doc["$schema"] == "./runtime-foundation-decision.schema.json", "foundation.$schema: wrong companion schema")
    require(doc["schemaVersion"] == 1, "foundation: unsupported schemaVersion")
    require(doc["decisionId"] == "ADR-COP-RUNTIME-001", "foundation.decisionId: wrong runtime decision")
    require(doc["decisionRef"] == "docs/adr/ADR-0019-greenfield-node26-and-service-topology.md", "foundation.decisionRef: wrong ADR")

    node = doc["runtime"]
    require(isinstance(node, dict), "foundation.runtime: object required")
    required_keys(node, {"node", "npm", "corepack", "packageManager"}, "foundation.runtime")
    for key, expected in (("node", NODE_VERSION), ("npm", NPM_VERSION), ("corepack", COREPACK_VERSION), ("packageManager", f"pnpm@{PNPM_VERSION}")):
        require(node[key] == expected, f"foundation.node.{key}: expected {expected}")

    image = doc["productionImage"]
    require(isinstance(image, dict), "foundation.productionImage: object required")
    required_keys(image, {"repository", "tag", "indexDigest", "platform", "platformManifestDigest", "reference"}, "foundation.productionImage")
    require(image["repository"] == "docker.io/library/node", "foundation.productionImage.repository: wrong image")
    require(image["tag"] == "26.8.1-bookworm-slim", "foundation.productionImage.tag: floating or wrong image")
    require(image["platform"] == "linux/amd64", "foundation.productionImage.platform: target platform must be linux/amd64")
    require(image["indexDigest"] == IMAGE_INDEX_DIGEST, "foundation.productionImage.indexDigest: unverified image index digest")
    require(image["platformManifestDigest"] == IMAGE_AMD64_DIGEST, "foundation.productionImage.platformManifestDigest: unverified target digest")
    require(image["reference"] == f"node:26.8.1-bookworm-slim@{IMAGE_AMD64_DIGEST}", "foundation.productionImage.reference: image must pin target digest")
    for field in ("platformManifestDigest", "indexDigest"):
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", image[field]) is not None, f"foundation.productionImage.{field}: invalid digest")
    require("latest" not in image["tag"] and "24" not in image["tag"], "foundation.productionImage: forbidden floating/Node24 image")

    registry = doc["registryVerification"]
    require(registry == {
        "verifiedAt": "2026-09-01",
        "command": "docker buildx imagetools inspect node:26.8.1-bookworm-slim",
        "digestPolicy": "record-index-and-pin-target-platform-manifest",
    }, "foundation.registryVerification: registry evidence changed")

    ts7 = doc["toolchainDecision"]
    require(isinstance(ts7, dict), "foundation.ts7Authority: object required")
    required_keys(ts7, {"decisionId", "decisionRef", "typescript", "structuralLinter", "typeAwareLinter", "openApiGenerator", "openApiGeneratorPlugin", "generatorMode", "compilerLanes"}, "foundation.toolchainDecision")
    require(ts7["decisionId"] == TS7_DECISION, "foundation.toolchainDecision.decisionId: ADR-0022 identity changed")
    require(ts7["decisionRef"] == "docs/adr/ADR-0022-ts7-native-toolchain.md", "foundation.toolchainDecision.decisionRef: ADR-0022 reference changed")
    require(ts7["typescript"] == "typescript@7.0.2", "foundation.toolchainDecision.typescript: TS7 pin changed")
    require(ts7["structuralLinter"] == "oxlint@1.80.0", "foundation.toolchainDecision.structuralLinter: pin changed")
    require(ts7["typeAwareLinter"] == "oxlint-tsgolint@7.0.2001", "foundation.toolchainDecision.typeAwareLinter: pin changed")
    require(ts7["openApiGenerator"] == "@hey-api/openapi-ts@0.0.0-next-20260824173136", "foundation.toolchainDecision.openApiGenerator: pin changed")
    require(ts7["openApiGeneratorPlugin"] == "@hey-api/typescript", "foundation.toolchainDecision.openApiGeneratorPlugin: plugin changed")
    require(ts7["generatorMode"] == "types-only", "foundation.ts7Authority.generatorMode: only types-only is allowed")
    require(ts7["compilerLanes"] == 1, "foundation.toolchainDecision.compilerLanes: second compiler lane is forbidden")
    exact_list(doc["prohibitions"], FOUNDATION_PROHIBITIONS, "foundation.prohibitions")
    require(doc["materializationOwner"] == "issue-3", "foundation.materializationOwner: workspace materialization belongs to issue #3")


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
        required_keys(entry, {"name", "owner", "m20Traceability", "networkZone", "dbPrincipal", "httpSurfaces", "secretRefs", "implemented", "transportMode"}, f"profile.runtimes.{name}")
        require(entry["owner"] == OWNERS[name], f"profile.runtimes.{name}.owner: owner changed")
        expected_transport = "public-tls" if name == "edge-gateway" else "mtls"
        require(entry["transportMode"] == expected_transport, f"profile.runtimes.{name}.transportMode: expected {expected_transport}")
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
        {"source": "edge-gateway", "method": "GET", "path": "/app/**", "target": "web", "targetPort": 3000},
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
    validate_schema_artifacts(platform)
    foundation = load_json(platform / "runtime-foundation-decision.json")
    profile = load_json(platform / "launch-v1-runtime-profile.json")
    connectivity = load_json(platform / "launch-v1-connectivity-policy.json")
    layout = load_json(platform / "target-layout.json")
    validate_foundation(foundation)
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
