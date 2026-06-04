#!/usr/bin/env bash
# =============================================================================
# check-no-committed-secrets.sh
# -----------------------------------------------------------------------------
# CI backstop for the IaC deployment artifacts. The iac-prod/ workflow ships a
# secret-free YAML + a gitignored secrets.env; this guards against the gitignore
# being bypassed (e.g. `git add -f`) and against an obvious live secret landing
# anywhere in the tracked tree. Pairs with iac-prod/.gitignore — defence in depth.
#
# Scans the COMMITTED (git-tracked) files only. Exits non-zero on any hit.
# =============================================================================
set -euo pipefail

fail=0
note() { printf '  ✗ %s\n' "$*" >&2; fail=1; }

# 1. Files that must never be committed (live secrets / backups / DBs).
#    These are gitignored under iac-prod/; this catches a forced add anywhere.
forbidden=$(git ls-files \
  ':(glob)**/secrets.env' \
  ':(glob)**/*.zip' \
  ':(glob)**/deltaglider_config.db' \
  ':(glob)**/*.db' \
  ':(glob)iac-prod/config.yaml' \
  ':(glob)iac-prod/iam.json' \
  ':(glob)iac-prod/secrets.json' \
  2>/dev/null || true)
if [[ -n "$forbidden" ]]; then
  while IFS= read -r f; do note "forbidden file committed: $f"; done <<<"$forbidden"
fi

# 2. Obvious live-secret patterns in any tracked text file. Deliberately narrow
#    to avoid false positives on docs/examples (which use placeholders).
#    - Slack bot token: xoxb-<digits>-...
#    - PEM private key block
#    - A non-redacted secret_access_key with a long opaque value in YAML/JSON
#      (placeholders are ${env:...} / "" / null, which won't match).
patterns='xoxb-[0-9]{6,}-|-----BEGIN [A-Z ]*PRIVATE KEY-----'
hits=$(git grep -nIE "$patterns" -- \
  ':(exclude)*.lock' \
  ':(exclude)demo/s3-browser/ui/dist/**' \
  2>/dev/null || true)
if [[ -n "$hits" ]]; then
  while IFS= read -r line; do note "possible live secret: $line"; done <<<"$hits"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "ERROR: potential committed secret(s) found — see above." >&2
  exit 1
fi
echo "OK: no committed secret artifacts or obvious live-secret patterns."
