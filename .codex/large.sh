#!/usr/bin/env bash
# Большой режим только для этого checkout; остальные аргументы идут Codex.
set -eu
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec codex -C "$project_dir" \
  -c 'model_reasoning_effort="medium"' \
  -c 'agents.max_concurrent_threads_per_session=8' "$@"
