#!/usr/bin/env python3
"""Positive and negative tests for the target-only Effect registry."""

from __future__ import annotations

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "validate-effect-toolchain-target.py"


def load_validator():
    spec = importlib.util.spec_from_file_location("effect_toolchain_target", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


VALIDATOR = load_validator()


def document(path: str) -> dict:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def candidate(registry: dict, schema: dict | None = None) -> Path:
    root = Path(tempfile.mkdtemp(prefix="effect-target-registry-"))
    (root / "config").mkdir()
    (root / "platform").mkdir()
    (root / "config" / "toolchain-versions.json").write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (root / "config" / "toolchain-versions.schema.json").write_text(json.dumps(schema or document("config/toolchain-versions.schema.json"), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    shutil.copy2(ROOT / "platform" / "runtime-foundation-decision.json", root / "platform" / "runtime-foundation-decision.json")
    return root


class EffectToolchainTargetTests(unittest.TestCase):
    def test_positive_registry(self) -> None:
        VALIDATOR.validate_root(ROOT)

    def test_bom_drift_is_rejected(self) -> None:
        registry = deepcopy(document("config/toolchain-versions.json"))
        registry["effectTarget"]["packages"]["effect"] = "4.0.0-rc.111"
        root = candidate(registry)
        try:
            with self.assertRaisesRegex(VALIDATOR.TargetError, "BOM differs"):
                VALIDATOR.validate_root(root)
        finally:
            shutil.rmtree(root)

    def test_schema_drift_is_rejected(self) -> None:
        registry = document("config/toolchain-versions.json")
        schema = deepcopy(document("config/toolchain-versions.schema.json"))
        schema["properties"]["effectTarget"]["const"]["generatedOpenApi"] = "3.2.0"
        root = candidate(registry, schema)
        try:
            with self.assertRaisesRegex(VALIDATOR.TargetError, "companion const differs"):
                VALIDATOR.validate_root(root)
        finally:
            shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
