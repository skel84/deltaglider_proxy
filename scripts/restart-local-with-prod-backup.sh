#!/usr/bin/env bash
# Restart the LOCAL test instance from a clean prod-backup restore.
#
# Per the user's standing preference: every restart re-imports the prod backup
# zip so the instance is a pristine copy of prod state, NOT whatever DB happens
# to be sitting in the working dir. Uses mode=preserve-bootstrap so the local
# admin login stays `admin` / `testpassword123` (the prod bootstrap password is
# NOT installed locally — we keep a known test password and re-encrypt the DB
# with it). This is the documented prod-to-local path.
#
# Usage: scripts/restart-local-with-prod-backup.sh [backup.zip] [port]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$REPO/target/release/deltaglider_proxy"
DIR="/private/tmp/dgp-local"
PORT="${2:-9000}"
PW="testpassword123"
BASE="http://127.0.0.1:${PORT}"

# Newest backup zip by default.
BACKUP="${1:-$(ls -t /private/tmp/dgp-backup-*.zip 2>/dev/null | head -1)}"
if [[ -z "${BACKUP}" || ! -f "${BACKUP}" ]]; then
  echo "ERROR: no backup zip found (looked for /private/tmp/dgp-backup-*.zip)" >&2
  exit 1
fi
echo "Backup:  ${BACKUP}"
echo "Binary:  ${BIN}"
echo "Port:    ${PORT}"

[[ -x "${BIN}" ]] || { echo "ERROR: release binary missing — run 'cargo build --release' first" >&2; exit 1; }

echo "==> Stopping any instance on :${PORT}"
pkill -f "target/release/deltaglider_proxy --listen 127.0.0.1:${PORT}" 2>/dev/null || true
sleep 1

echo "==> Wiping ${DIR} for a clean restore"
rm -rf "${DIR}"
mkdir -p "${DIR}/data"

# Minimal seed config so the clean pre-restore boot has valid SigV4 auth
# (the proxy refuses to start without it). These placeholder creds are
# overwritten by the restore's config + secrets from the zip.
cat > "${DIR}/deltaglider_proxy.yaml" <<EOF
access:
  access_key_id: admin
  secret_access_key: seed-placeholder-overwritten-by-restore
storage:
  backend:
    type: filesystem
    path: ${DIR}/data
EOF

echo "==> Setting local bootstrap password to a known test value"
( cd "${DIR}" && printf '%s\n' "${PW}" | "${BIN}" --set-bootstrap-password >/dev/null )

echo "==> Launching instance"
( cd "${DIR}" && nohup "${BIN}" --listen "127.0.0.1:${PORT}" > "${DIR}/proxy.log" 2>&1 & echo $! > "${DIR}/proxy.pid" )
sleep 2
curl -fsS -o /dev/null -w "    health %{http_code}\n" "${BASE}/_/health"

echo "==> Logging in as admin"
COOKIES="${DIR}/cookies.txt"
curl -fsS -c "${COOKIES}" -X POST "${BASE}/_/api/admin/login" \
  -H 'Content-Type: application/json' -d "{\"password\":\"${PW}\"}" \
  -w "    login %{http_code}\n" -o /dev/null

echo "==> Restoring prod backup (mode=preserve-bootstrap)"
curl -fsS -b "${COOKIES}" -X POST "${BASE}/_/api/admin/backup?mode=preserve-bootstrap" \
  -H 'Content-Type: application/zip' --data-binary "@${BACKUP}" \
  -w "\n    restore %{http_code}\n"

echo "==> Restarting so the restored config + re-encrypted IAM DB load fresh"
pkill -f "target/release/deltaglider_proxy --listen 127.0.0.1:${PORT}" 2>/dev/null || true
sleep 1
( cd "${DIR}" && nohup "${BIN}" --listen "127.0.0.1:${PORT}" > "${DIR}/proxy.log" 2>&1 & echo $! > "${DIR}/proxy.pid" )
sleep 2
curl -fsS -o /dev/null -w "    health %{http_code}\n" "${BASE}/_/health"
echo "==> IAM loaded:"
grep -iE "Loaded .* IAM users|Authentication:|External auth:" "${DIR}/proxy.log" | tail -3
echo
echo "Ready: ${BASE}/_/   (login: admin / ${PW})"
