#!/usr/bin/env bash
# Every integration test crate (tests/<name>.rs, excluding common/) must be
# referenced in `.github/workflows/ci.yml` via `cargo test ... --test <name>`
# (the PR merge gate). Nightly `cargo test --all` is supplementary.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

shopt -s nullglob
missing=()
for f in tests/*.rs; do
  name=$(basename "$f" .rs)
  if [[ "$name" == "common" ]]; then
    continue
  fi
  # Require `--test <crate>` as a token (avoid matching `--test s3` inside `--test s3_api_test`).
  if ! grep -qE -- "--test ${name}([^a-z0-9_]|$)" .github/workflows/ci.yml; then
    missing+=("$name")
  fi
done

if ((${#missing[@]} > 0)); then
  echo "error: integration test crate(s) not referenced in .github/workflows/ci.yml:" >&2
  printf '  --test %s\n' "${missing[@]}" >&2
  echo "Add them to a CI job in ci.yml (see also test-all-nightly.yml for full-matrix runs)." >&2
  exit 1
fi

echo "OK: all tests/*.rs crates are registered in CI workflows."
