#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 CANDIDATE_RELEASE EXPECTED_CURRENT" >&2
  exit 64
fi

RELEASES_ROOT="${MOLI_DRAMA_RELEASES_ROOT:-/opt/moli-drama/releases}"
CURRENT_LINK="${MOLI_DRAMA_CURRENT_LINK:-/opt/moli-drama/current}"
SHARED_ROOT="${MOLI_DRAMA_SHARED_ROOT:-/opt/moli-drama/shared}"
SHARED_VERIFIER="$SHARED_ROOT/release-guard/verify-protected-release.js"
LOCK_FILE="$SHARED_ROOT/deploy.lock"
if [[ ! -e "$1" || ! -e "$2" ]]; then
  echo "candidate and expected current must both exist" >&2
  exit 66
fi
CANDIDATE="$(realpath -- "$1")"
EXPECTED_CURRENT="$(realpath -- "$2")"

case "$CANDIDATE" in
  "$RELEASES_ROOT"/*) ;;
  *) echo "candidate must be inside $RELEASES_ROOT" >&2; exit 65 ;;
esac
case "$EXPECTED_CURRENT" in
  "$RELEASES_ROOT"/*) ;;
  *) echo "expected current must be inside $RELEASES_ROOT" >&2; exit 65 ;;
esac

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another production release is in progress" >&2
  exit 75
fi

ACTUAL_CURRENT="$(readlink -f "$CURRENT_LINK")"
if [[ "$ACTUAL_CURRENT" != "$EXPECTED_CURRENT" ]]; then
  echo "current release changed: expected=$EXPECTED_CURRENT actual=$ACTUAL_CURRENT" >&2
  exit 73
fi
if [[ ! -f "$SHARED_VERIFIER" ]]; then
  echo "shared protected release verifier is missing" >&2
  exit 69
fi

node "$SHARED_VERIFIER" "$CANDIDATE" --require-build
if [[ "${PROTECTED_RELEASE_VERIFY_ONLY:-0}" == "1" ]]; then
  echo "protected_release_verified=$CANDIDATE"
  exit 0
fi
if [[ "$CANDIDATE" == "$ACTUAL_CURRENT" ]]; then
  echo "protected_release_verified=$CANDIDATE"
  exit 0
fi

rollback() {
  ln -sfn "$ACTUAL_CURRENT" "${CURRENT_LINK}.rollback"
  mv -Tf "${CURRENT_LINK}.rollback" "$CURRENT_LINK"
  if ! systemctl restart moli-drama.service; then
    echo "symlink rolled back to $ACTUAL_CURRENT but service restart failed" >&2
    return 1
  fi
}

ln -sfn "$CANDIDATE" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK"
if ! systemctl restart moli-drama.service; then
  rollback || true
  echo "release restart failed; rolled back to $ACTUAL_CURRENT" >&2
  exit 70
fi

healthy=0
for _ in {1..20}; do
  if curl --fail --silent --show-error http://127.0.0.1:5679/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" -ne 1 ]]; then
  rollback || true
  echo "release health check failed; rolled back to $ACTUAL_CURRENT" >&2
  exit 70
fi

echo "protected_release_switched_from=$ACTUAL_CURRENT"
echo "protected_release_switched_to=$CANDIDATE"
