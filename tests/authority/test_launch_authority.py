#!/usr/bin/env python3
"""Deterministic positive and negative tests for launch authority."""

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
EFFECT_CASES_PATH = TEST_ROOT / "fixtures" / "negative" / "effect-cases.json"
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
    elif operation == "add":
        parent[leaf] = value  # type: ignore[index]
    else:
        raise AssertionError(f"unknown fixture operation: {operation}")


def candidate_root(manifest: str, candidate: dict) -> Path:
    root = Path(tempfile.mkdtemp(prefix="issue19-authority-test-"))
    platform = root / "platform"
    config = root / "config"
    docs = root / "docs" / "launch"
    platform.mkdir()
    config.mkdir()
    docs.mkdir(parents=True)
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
    for name in ("toolchain-versions.json", "toolchain-versions.schema.json"):
        source = json.loads((FIXTURE_ROOT / "config" / name).read_text(encoding="utf-8"))
        if name == manifest:
            source = candidate
        (config / name).write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    shutil.copy2(FIXTURE_ROOT / "docs" / "launch" / "13_DELIVERY_DEPENDENCY_GRAPH.md", docs / "13_DELIVERY_DEPENDENCY_GRAPH.md")
    return root


class LaunchAuthorityTests(unittest.TestCase):
    def test_positive_fixture_is_accepted(self) -> None:
        VALIDATOR.validate_root(FIXTURE_ROOT)

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
        with tempfile.TemporaryDirectory(prefix="issue19-duplicate-json-") as temporary:
            path = Path(temporary) / "duplicate.json"
            path.write_text('{"schemaVersion":1,"schemaVersion":2}\n', encoding="utf-8")
            with self.assertRaises(VALIDATOR.AuthorityError):
                VALIDATOR.load_json(path)

    def test_effect_v2_negative_fixtures_are_rejected_without_mutating_sources(self) -> None:
        cases = json.loads(EFFECT_CASES_PATH.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 5)
        for case in cases:
            with self.subTest(case=case["id"]):
                original = fixture_doc(case["manifest"]) if case["manifest"].startswith("runtime-") else json.loads((FIXTURE_ROOT / "config" / case["manifest"]).read_text(encoding="utf-8"))
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


if __name__ == "__main__":
    unittest.main()
