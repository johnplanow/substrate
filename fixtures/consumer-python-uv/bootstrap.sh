#!/bin/sh
# Bootstrap the fixture env (CI + local). Idempotent.
set -e
cd "$(dirname "$0")"
uv sync --quiet
uv run pytest -q
