#!/usr/bin/env python3
"""Deterministic positive and negative tests for issue #19 authority."""

from __future__ import annotations

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


TEST_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TEST_ROOT.parents[1]
FIXTURE_ROOT = REPO_ROOT
CASES_PATH = TEST_ROOT / "fixtures" / "negative" / "cases.json"
SCRIPT_PATH = TEST_ROOT.parents[1] / "scripts" / "validate-launch-authority.py"


def load_validator():
    spec = importlib.util.spec_from_file_location("launch_authority_validator", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import validator: {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


VALIDATOR = load_validator()


def fixture_doc(name: str) -> dict:
    return json.loads((FIXTURE_ROOT / "platform" / name).read_text(encoding="utf-8"))


def set_at(document: object, path: list[object], value: object, operation: str) -> None:
    parent = document
    for part in path[:-1]:
        parent = parent[part]  # type: ignore[index]
    leaf = path[-1]
    if operation == "replace":
        parent[leaf] = value  # type: ignore[index]
    elif operation == "remove":
        del parent[leaf]  # type: ignore[index]
    elif operation == "remove-index":
        del parent[leaf][value]  # type: ignore[index]
    else:
        raise AssertionError(f"unknown fixture operation: {operation}")


def candidate_root(manifest: str, candidate: dict) -> Path:
    root = Path(tempfile.mkdtemp(prefix="authority-test-"))
    platform = root / "platform"
    platform.mkdir()
    for name in (
        "runtime-foundation-decision.json",
        "launch-v1-runtime-profile.json",
        "launch-v1-connectivity-policy.json",
        "target-layout.json",
        "runtime-foundation-decision.schema.json",
        "launch-v1-runtime-profile.schema.json",
        "launch-v1-connectivity-policy.schema.json",
        "target-layout.schema.json",
    ):
        source = fixture_doc(name)
        if name == manifest:
            source = candidate
        (platform / name).write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return root


class LaunchAuthorityTests(unittest.TestCase):
    def test_catalog_convergence_exact_tuple_is_accepted(self) -> None:
        allowlist = fixture_doc("launch-v1-runtime-profile.json")["internalOperationAllowlist"]
        convergence = {
            "originalCaller": "aroma-convergence",
            "target": "catalog-service",
            "method": "GET",
            "path": "/api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input",
            "operationId": "getCatalogPricingInput",
            "mutation": False,
        }
        # Проверяем желаемую authority независимо от неполного исходного profile.
        allowlist = [row for row in allowlist if not (row["originalCaller"] == "aroma-convergence" and row["target"] == "catalog-service")]
        allowlist.append(convergence)
        VALIDATOR.validate_allowlist(allowlist)

    def test_positive_fixture_is_accepted(self) -> None:
        VALIDATOR.validate_root(FIXTURE_ROOT)

    def test_node_network_enforcement_label_is_a_fixed_fact(self) -> None:
        policy = fixture_doc("launch-v1-connectivity-policy.json")
        schema = fixture_doc("launch-v1-connectivity-policy.schema.json")
        self.assertEqual(policy["nodeNetworkEnforcement"], "global-only")
        self.assertEqual(schema["properties"]["nodeNetworkEnforcement"]["const"], "global-only")

    def test_foundation_keeps_the_approved_index_and_target_platform_binding(self) -> None:
        baseline = fixture_doc("runtime-foundation-decision.json")
        VALIDATOR.validate_foundation(baseline)
        image = baseline["productionImage"]
        cases = (
            ("indexDigest", "sha256:" + "0" * 64),
            ("platformManifestDigest", "sha256:" + "0" * 64),
            ("platform", "linux/arm64"),
            ("reference", f"node:{image['tag']}@{image['platformManifestDigest']}"),
        )
        for field, value in cases:
            with self.subTest(field=field):
                candidate = deepcopy(baseline)
                candidate["productionImage"][field] = value
                with self.assertRaisesRegex(VALIDATOR.AuthorityError, f"foundation.productionImage.{field}"):
                    VALIDATOR.validate_foundation(candidate)

    def test_catalog_profile_contains_both_exact_callers(self) -> None:
        rows = fixture_doc("launch-v1-runtime-profile.json")["internalOperationAllowlist"]
        self.assertEqual(
            [row for row in rows if row["target"] == "catalog-service"],
            [{
                "originalCaller": caller,
                "target": "catalog-service",
                "method": "GET",
                "path": "/api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input",
                "operationId": "getCatalogPricingInput",
                "mutation": False,
            } for caller in ("pricing-service", "aroma-convergence")],
        )

    def test_catalog_convergence_allowlist_rejects_drift(self) -> None:
        profile = fixture_doc("launch-v1-runtime-profile.json")
        VALIDATOR.validate_runtime_profile(profile)
        rows = profile["internalOperationAllowlist"]
        index = next(i for i, row in enumerate(rows) if row["originalCaller"] == "aroma-convergence" and row["target"] == "catalog-service")
        changes = (
            ("missing", None, None),
            ("duplicate", None, None),
            ("unauthorized-caller", "originalCaller", "aroma-observer"),
            ("wrong-operation", "operationId", "readAromaCartSnapshot"),
            ("mutation", "mutation", True),
            ("wrong-target", "target", "aroma-gateway"),
            ("wrong-method", "method", "POST"),
            ("wrong-path", "path", "/api/internal-v1/catalog/products"),
        )
        for case, field, value in changes:
            with self.subTest(case=case):
                candidate = deepcopy(profile)
                candidate_rows = candidate["internalOperationAllowlist"]
                if case == "missing":
                    del candidate_rows[index]
                elif case == "duplicate":
                    candidate_rows.append(deepcopy(candidate_rows[index]))
                else:
                    candidate_rows[index][field] = value
                with self.assertRaisesRegex(VALIDATOR.AuthorityError, "exact caller/target/operation allowlist changed"):
                    VALIDATOR.validate_runtime_profile(candidate)
        self.assertEqual(profile, fixture_doc("launch-v1-runtime-profile.json"))

    def test_catalog_identity_and_catalog_staging_authority_are_synchronized(self) -> None:
        profile = fixture_doc("launch-v1-runtime-profile.json")
        self.assertEqual(
            profile["catalogIdentity"],
            {
                "algorithm": "hmac-sha256-v1",
                "secretRef": "aroma.catalogIdentityKeyV1",
                "keyInput": "dedicated-secret-ref-no-logging",
                "inputEncoding": "UTF-8",
                "input": ["hmac-sha256-v1", "0x00", "supplierRef", "0x00", "entityType", "0x00", "NFC(rawProviderIdentifier)"],
                "separatorByte": 0,
                "entityTypes": ["product", "variant", "offer", "grind"],
                "supplierRefPolicy": "canonical-sup-ulid",
                "rawProviderIdentifierPolicy": "non-empty-nul-free-nfc-no-trim-no-case-fold",
                "outputEncoding": "lowercase-hex",
                "variantIdPolicy": "never-generated",
                "collisionPolicy": "quarantine-generation",
                "rotationPolicy": "versioned-key-new-snapshots-only-existing-identities-remain-stable",
            },
        )
        role_map = json.loads((FIXTURE_ROOT / "config" / "database-role-map.json").read_text(encoding="utf-8"))
        catalog = next(database for database in role_map["databases"] if database["name"] == "coffee_platform_catalog")
        for runtime_role in catalog["runtimeRoles"]:
            if runtime_role["runtime"] in {"catalog-supplier-sync", "catalog-activation-worker"}:
                self.assertIn("supplier_snapshots", runtime_role["tables"])
                self.assertNotIn("snapshot_generations", runtime_role["tables"])

    def test_validator_cli_is_deterministic(self) -> None:
        command = [sys.executable, str(SCRIPT_PATH), "--root", str(FIXTURE_ROOT)]
        first = subprocess.run(command, check=False, capture_output=True, text=True)
        second = subprocess.run(command, check=False, capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual((first.returncode, first.stdout, first.stderr), (second.returncode, second.stdout, second.stderr))

    def test_negative_fixtures_are_rejected_without_mutating_sources(self) -> None:
        cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 15)
        for case in cases:
            with self.subTest(case=case["id"]):
                self.assertRegex(case["expected"]["ruleId"], r"^[A-Z0-9_]+$")
                original = fixture_doc(case["manifest"])
                candidate = deepcopy(original)
                set_at(candidate, case["path"], case.get("value"), case["operation"])
                before = json.dumps(original, sort_keys=True)
                root = candidate_root(case["manifest"], candidate)
                try:
                    with self.assertRaises(VALIDATOR.AuthorityError) as caught:
                        VALIDATOR.validate_root(root)
                    self.assertIn(case["expected"]["message"], str(caught.exception))
                finally:
                    shutil.rmtree(root)
                self.assertEqual(before, json.dumps(original, sort_keys=True), case["id"])

    def test_duplicate_json_keys_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="authority-duplicate-json-") as temporary:
            path = Path(temporary) / "duplicate.json"
            path.write_text('{"schemaVersion":1,"schemaVersion":2}\n', encoding="utf-8")
            with self.assertRaises(VALIDATOR.AuthorityError):
                VALIDATOR.load_json(path)


if __name__ == "__main__":
    unittest.main()
