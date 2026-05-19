#!/usr/bin/env bash
# Forbid inline "savings %" math outside the central modules.
#
# History: three independent inline formulas (admin dashboard, CLI
# stats, SPA chip + upload + inspector) all undercounted by ignoring
# `reference.bin` and capped differently, producing "100% saved" lies
# on production buckets. The fix consolidates everything into
# `src/deltaglider/savings.rs` (Rust) and
# `demo/s3-browser/ui/src/savings.ts` (TS). This script is the lock
# on the door so the pattern can't be reintroduced silently.
#
# The first version of this guard had a narrow regex (only
# `storedSize`/`originalSize`). A subsequent audit found that
# `BucketScanCard.tsx` + `AnalyticsSection.tsx` used `storedBytes`
# and `original_bytes` variable names and dodged the guard entirely.
# The patterns below cover BOTH naming conventions and the sign-
# flipped `(orig - stored) / orig` shape that's semantically the
# same thing.
#
# What's forbidden (broad match for any savings-ratio shape):
#   Rust  : `1.0 - <expr containing stored> / <expr containing original>`
#           `(<expr w/ original> - <expr w/ stored>) / <expr w/ original>`
#           `delta_size().unwrap_or(<expr w/ file_size>)` shortcut
#   TS    : same two ratio shapes for {storedSize,storedBytes,stored_bytes}
#           against {originalSize,originalBytes,original_bytes}
#
# Allow-listed files: the centralization modules themselves and a few
# constructors that legitimately compute a *different* quantity:
#   src/deltaglider/savings.rs                — the single source of truth
#   src/types.rs                              — FileMetadata::stored_size
#   src/api/admin/delta_efficiency.rs         — per-row diagnostic ratios
#   src/deltaglider/codec.rs                  — DeltaCodec ratio post-encode
#   src/deltaglider/engine/store.rs           — encode threshold check
#   demo/s3-browser/ui/src/savings.ts         — TS canonical module
#
# Note on technique: grep is regex-based and line-oriented. It cannot
# match expressions split across multiple lines, and it cannot tell a
# comment apart from code. We mitigate both with allow-lists and a
# stripping pre-pass for `//`/`#`/`///` comments. An AST-based check
# (cargo xtask using `syn`) is the long-term replacement; this script
# is the cheap lock that catches 90% of regressions.
#
# Run locally:  ./scripts/check-savings-math.sh
# Exit 0 = clean, non-zero = forbidden pattern detected.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

violations=()

# Allow-listed files (full path from project root).
allowed_rust=(
  "src/deltaglider/savings.rs"
  "src/types.rs"
  "src/api/admin/delta_efficiency.rs"
  "src/deltaglider/codec.rs"
  "src/deltaglider/engine/store.rs"
)
allowed_ts=(
  "demo/s3-browser/ui/src/savings.ts"
)

is_allowed() {
  local path="$1"
  shift
  for a in "$@"; do
    if [[ "$path" == "$a" ]]; then
      return 0
    fi
  done
  return 1
}

# Strip Rust + TS // line comments and /// doc lines BEFORE scanning,
# so a literal "1.0 - stored / original" in a doc example doesn't
# trip the check. Block /* */ comments aren't stripped — keep your
# block-comment savings math out of source code please.
strip_comments() {
  # Strip everything from the first `//` to EOL on each line. Doesn't
  # cope with `//` inside string literals; we accept that tiny gap to
  # keep this readable.
  sed -E 's|//.*$||' "$1"
}

# Common "stored"/"original" name fragments — any of these on either
# side of a `/` (with the other being the inverse) is suspicious.
# These cover the THREE conventions we've actually seen in the
# codebase: PascalCase (storedSize/originalSize), camelCase
# (storedBytes/originalBytes), snake_case (stored_bytes/original_bytes).
stored_names='(stored[_]?(size|bytes)|storedSize|storedBytes|stored_bytes)'
original_names='(original[_]?(size|bytes)|originalSize|originalBytes|original_bytes|file_size)'

# Rust ratio patterns.
#  Form A:  1.0 - <…stored…> / <…original…>
#  Form B:  (<…original…> - <…stored…>) / <…original…>
# We match on the LINE level after stripping `//` comments.
rust_pattern_a="1\\.0?\\s*-\\s*[^;]*${stored_names}[^;]*/[^;]*${original_names}"
rust_pattern_b="\\([^()]*${original_names}[^()]*-[^()]*${stored_names}[^()]*\\)\\s*/"
rust_pattern_legacy='delta_size\(\)\.unwrap_or\([^)]*file_size\)'

# TS ratio patterns — same two shapes.
ts_pattern_a="1\\s*-\\s*[^;]*${stored_names}[^;]*/[^;]*${original_names}"
ts_pattern_b="\\([^()]*${original_names}[^()]*-[^()]*${stored_names}[^()]*\\)\\s*/"

scan_rust() {
  local pattern="$1"
  local message="$2"
  shopt -s globstar nullglob
  for f in src/**/*.rs; do
    case "$f" in
      tests/*) continue ;;
    esac
    if is_allowed "$f" "${allowed_rust[@]}"; then
      continue
    fi
    local tmp
    tmp=$(mktemp)
    strip_comments "$f" > "$tmp"
    # Use -n for line numbers, -E for extended regex.
    while IFS=: read -r line _; do
      [[ -z "$line" ]] && continue
      violations+=("$f:$line: $message")
    done < <(grep -nE "$pattern" "$tmp" || true)
    rm -f "$tmp"
  done
}

scan_ts() {
  local pattern="$1"
  local message="$2"
  shopt -s globstar nullglob
  for f in demo/s3-browser/ui/src/**/*.ts demo/s3-browser/ui/src/**/*.tsx; do
    case "$f" in
      *node_modules/*|*dist/*) continue ;;
    esac
    if is_allowed "$f" "${allowed_ts[@]}"; then
      continue
    fi
    local tmp
    tmp=$(mktemp)
    strip_comments "$f" > "$tmp"
    while IFS=: read -r line _; do
      [[ -z "$line" ]] && continue
      violations+=("$f:$line: $message")
    done < <(grep -nE "$pattern" "$tmp" || true)
    rm -f "$tmp"
  done
}

# Run the scans.
scan_rust "$rust_pattern_a" \
  "inline savings ratio '1.0 - stored/original' — use SavingsTotals::savings_percentage"
scan_rust "$rust_pattern_b" \
  "inline savings ratio '(original - stored)/original' — use SavingsTotals::savings_percentage"
scan_rust "$rust_pattern_legacy" \
  "legacy 'delta_size().unwrap_or(file_size)' — use FileMetadata::stored_size()"

scan_ts "$ts_pattern_a" \
  "inline savings ratio '1 - stored/original' — use summarizeScopeSavings/summarizeObjectSavings from src/savings.ts"
scan_ts "$ts_pattern_b" \
  "inline savings ratio '(original - stored)/original' — use summarizeScopeSavings/summarizeObjectSavings from src/savings.ts"

if ((${#violations[@]} > 0)); then
  echo "error: inline savings math detected outside the central modules:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  echo "" >&2
  echo "Centralised modules:" >&2
  echo "  Rust → src/deltaglider/savings.rs (SavingsTotals) + FileMetadata::stored_size()" >&2
  echo "  TS   → demo/s3-browser/ui/src/savings.ts (summarizeObjectSavings, summarizeScopeSavings)" >&2
  exit 1
fi

echo "OK: no inline savings math found outside the central modules."
