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
# What's forbidden:
#   Rust  : the byte-ratio pattern `1.0 - .*stored.*/.*original`
#           the legacy "stored size" shortcut `delta_size().unwrap_or(.*file_size)`
#           (use `FileMetadata::stored_size()` instead)
#   TS    : the byte-ratio pattern `1 - .*storedSize.*/.*originalSize`
#           (use `summarizeObjectSavings` / `summarizeScopeSavings` instead)
#
# Allow-listed files (the centralization modules themselves and a few
# constructors that legitimately compute the formula once on input):
#   src/deltaglider/savings.rs
#   src/types.rs                       (constructors)
#   src/api/admin/delta_efficiency.rs  (computes per-row delta_size/original_size for diagnostics)
#   src/deltaglider/codec.rs           (DeltaCodec::compression_ratio post-encode)
#   src/deltaglider/engine/store.rs    (delta_size/original ratio threshold check)
#   demo/s3-browser/ui/src/savings.ts
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

# ─── Rust: forbidden ratio formulas ──────────────────────────────────
while IFS=: read -r path line _; do
  [[ -z "$path" ]] && continue
  # Exclude tests/ — assertions there legitimately reproduce the
  # algorithm to pin invariants. Exclude target/ build output.
  case "$path" in
    target/*|tests/*) continue ;;
  esac
  if is_allowed "$path" "${allowed_rust[@]}"; then
    continue
  fi
  violations+=("$path:$line: forbidden inline savings ratio (use SavingsTotals::savings_percentage or saved_bytes)")
done < <(grep -rnE '1\.0\s*-\s*[^;]*stored[^;]*/[^;]*original|\(1\.0?\s*-\s*[^)]*stored[^)]*\s*/\s*[^)]*original[^)]*\)' --include='*.rs' src/ || true)

# Rust: forbidden "stored size" shortcut.
while IFS=: read -r path line _; do
  [[ -z "$path" ]] && continue
  case "$path" in
    target/*|tests/*) continue ;;
  esac
  if is_allowed "$path" "${allowed_rust[@]}"; then
    continue
  fi
  violations+=("$path:$line: legacy 'delta_size().unwrap_or(file_size)' — use FileMetadata::stored_size()")
done < <(grep -rnE 'delta_size\(\)\.unwrap_or\([^)]*file_size\)' --include='*.rs' src/ || true)

# ─── TypeScript: forbidden ratio formulas ───────────────────────────
while IFS=: read -r path line _; do
  [[ -z "$path" ]] && continue
  case "$path" in
    *node_modules/*|*dist/*) continue ;;
  esac
  if is_allowed "$path" "${allowed_ts[@]}"; then
    continue
  fi
  violations+=("$path:$line: forbidden inline savings ratio (use summarizeObjectSavings or summarizeScopeSavings from src/savings.ts)")
done < <(grep -rnE '\(\s*1\s*-\s*[^)]*storedSize[^)]*/\s*[^)]*originalSize[^)]*\)|1\s*-\s*[^;]*storedSize[^;]*/[^;]*originalSize' --include='*.ts' --include='*.tsx' demo/s3-browser/ui/src/ || true)

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
