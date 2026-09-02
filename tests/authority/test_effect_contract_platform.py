#!/usr/bin/env python3
"""Positive and RED-fixture tests for issue #27 contract authority."""

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
SCRIPT_PATH = REPO_ROOT / "scripts" / "validate-effect-contract-platform.py"
CONFIG_PATH = REPO_ROOT / "config" / "effect-contract-platform.json"
SCHEMA_PATH = REPO_ROOT / "config" / "effect-contract-platform.schema.json"
CASES_PATH = TEST_ROOT / "fixtures" / "negative" / "effect-contract-platform-cases.json"


def load_validator():
    spec = importlib.util.spec_from_file_location("effect_contract_platform_validator", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import validator: {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


VALIDATOR = load_validator()


def set_at(document: object, path: list[object], value: object, operation: str) -> None:
    parent = document
    for part in path[:-1]:
        parent = parent[part]  # type: ignore[index]
    leaf = path[-1]
    if operation == "replace":
        parent[leaf] = value  # type: ignore[index]
        return
    if operation == "remove":
        del parent[leaf]  # type: ignore[index]
        return
    raise AssertionError(f"unknown operation: {operation}")


def candidate_root(document: dict) -> Path:
    root = Path(tempfile.mkdtemp(prefix="issue27-contract-authority-"))
    (root / "config").mkdir(parents=True)
    (root / "docs" / "adr").mkdir(parents=True)
    (root / "evidence" / "handoffs").mkdir(parents=True)
    (root / "config" / "effect-contract-platform.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    shutil.copyfile(SCHEMA_PATH, root / "config" / "effect-contract-platform.schema.json")
    (root / "config" / "effect-legacy-inventory.json").write_text("{}\n", encoding="utf-8")
    (root / "docs" / "adr" / "ADR-0023-effect-native-platform.md").write_text("# fixture\n", encoding="utf-8")
    (root / "evidence" / "handoffs" / "issue-26.yaml").write_text("issue: 26\n", encoding="utf-8")
    return root


class EffectContractPlatformTests(unittest.TestCase):
    def test_repository_authority_is_accepted(self) -> None:
        VALIDATOR.validate_authority(REPO_ROOT)

    def test_cli_result_is_deterministic(self) -> None:
        command = [sys.executable, str(SCRIPT_PATH), "--root", str(REPO_ROOT)]
        first = subprocess.run(command, check=False, capture_output=True, text=True)
        second = subprocess.run(command, check=False, capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(
            (first.returncode, first.stdout, first.stderr),
            (second.returncode, second.stdout, second.stderr),
        )

    def test_red_fixtures_are_rejected(self) -> None:
        source = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 8)
        for case in cases:
            with self.subTest(case=case["id"]):
                candidate = deepcopy(source)
                set_at(candidate, case["path"], case.get("value"), case["operation"])
                root = candidate_root(candidate)
                try:
                    with self.assertRaises(VALIDATOR.ContractAuthorityError) as caught:
                        VALIDATOR.validate_authority(root)
                    self.assertIn(case["expectedRule"], str(caught.exception))
                finally:
                    shutil.rmtree(root)

    def test_duplicate_json_keys_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="issue27-duplicate-json-") as temporary:
            path = Path(temporary) / "duplicate.json"
            path.write_text('{"issue":27,"issue":28}\n', encoding="utf-8")
            with self.assertRaises(VALIDATOR.ContractAuthorityError):
                VALIDATOR.load_json(path)


if __name__ == "__main__":
    unittest.main()
