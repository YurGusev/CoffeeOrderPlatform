#!/usr/bin/env python3
"""Validate that the target Effect toolchain registry matches machine authority."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


class TargetError(ValueError):
    pass


class DuplicateKeyError(ValueError):
    pass


def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=pairs)
    except (OSError, json.JSONDecodeError, DuplicateKeyError) as error:
        raise TargetError(f"cannot read strict JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise TargetError(f"object root required: {path}")
    return value


def require(condition: bool, message: str) -> None:
    if not condition:
        raise TargetError(message)


def validate_root(root: Path) -> None:
    registry = load(root / "config" / "toolchain-versions.json")
    registry_schema = load(root / "config" / "toolchain-versions.schema.json")
    decision = load(root / "platform" / "runtime-foundation-decision.json")

    require(registry.get("schemaVersion") == 2, "effect target registry: schemaVersion must be 2")
    target = registry.get("effectTarget")
    require(isinstance(target, dict), "effect target registry: effectTarget object required")
    require(target.get("authorityRef") == decision.get("decisionRef"), "effect target registry: authorityRef differs from runtime decision")
    require(target.get("materializationOwner") == "issue-26", "effect target registry: materialization owner must be issue-26")
    require(target.get("admissionOwner") == "issue-32", "effect target registry: admission owner must be issue-32")
    require(target.get("generatedOpenApi") == "3.1.0", "effect target registry: generated OpenAPI must be 3.1.0")
    require(target.get("packages") == decision.get("effectPlatform", {}).get("bom"), "effect target registry: package BOM differs from runtime decision")

    require(registry_schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "effect target schema: draft 2020-12 required")
    require(registry_schema.get("type") == "object" and registry_schema.get("additionalProperties") is False, "effect target schema: closed object required")
    required = registry_schema.get("required")
    require(isinstance(required, list) and "effectTarget" in required, "effect target schema: effectTarget must be required")
    properties = registry_schema.get("properties")
    require(isinstance(properties, dict), "effect target schema: properties object required")
    effect_schema = properties.get("effectTarget")
    require(isinstance(effect_schema, dict) and effect_schema.get("const") == target, "effect target schema: companion const differs from registry")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        validate_root(args.root.resolve())
    except TargetError as error:
        print(f"effect target registry: FAIL: {error}", file=sys.stderr)
        return 1
    print("effect target registry: target BOM/owners/artifacts match machine authority")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
