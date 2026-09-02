#!/usr/bin/env python3
"""Deterministic positive and negative tests for Effect-native launch authority."""

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
CASES_PATHS = [
    TEST_ROOT / "fixtures" / "negative" / "cases.json",
    TEST_ROOT / "fixtures" / "negative" / "effect-cases.json",
]
SCRIPT_PATH = REPO_ROOT / "scripts" / "validate-effect-authority.py"


def load_validator():
    spec = importlib.util.spec_from_file_location("effect_launch_authority_validator", SCRIPT_PATH)
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
    root = Path(tempfile.mkdtemp(prefix="issue25-effect-authority-test-"))
    shutil.copytree(REPO_ROOT / "platform", root / "platform")
    shutil.copytree(REPO_ROOT / "scripts", root / "scripts")
    (root / "platform" / manifest).write_text(json.dumps(candidate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return root


class EffectLaunchAuthorityTests(unittest.TestCase):
    def test_positive_fixture_is_accepted(self) -> None:
        VALIDATOR.validate_root(FIXTURE_ROOT)

    def test_validator_cli_is_deterministic(self) -> None:
        command = [sys.executable, str(SCRIPT_PATH), "--root", str(FIXTURE_ROOT)]
        first = subprocess.run(command, check=False, capture_output=True, text=True)
        second = subprocess.run(command, check=False, capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual((first.returncode, first.stdout, first.stderr), (second.returncode, second.stdout, second.stderr))

    def test_negative_fixtures_are_rejected_without_mutating_sources(self) -> None:
        cases = [case for path in CASES_PATHS for case in json.loads(path.read_text(encoding="utf-8"))]
        self.assertGreaterEqual(len(cases), 40)
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
        with tempfile.TemporaryDirectory(prefix="effect-authority-duplicate-json-") as temporary:
            path = Path(temporary) / "duplicate.json"
            path.write_text('{"schemaVersion":1,"schemaVersion":2}\n', encoding="utf-8")
            with self.assertRaises(VALIDATOR.AuthorityError):
                VALIDATOR.load_json(path)


if __name__ == "__main__":
    unittest.main()
