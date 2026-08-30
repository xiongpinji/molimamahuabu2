#!/bin/bash -p
set -euo pipefail

readonly SAFE_PATH='/usr/sbin:/usr/bin:/sbin:/bin'
readonly NODE_BINARY='/usr/bin/node'
readonly PYTHON_BINARY='/usr/bin/python3'
readonly EXPECTED_INSTALLED_EXTERNAL_VERIFIER_SHA256='ff920ad0ff2bd053a9fda492dc7c88e1b0e64f038dd66b2795b8417670feedb0'
readonly EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256='895a89cc984a14775ab0c0fcb0d73d6137e558ff54e466815de1b3f7fb586e48'
PATH="$SAFE_PATH"
export PATH
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH GLOBIGNORE
umask 077

fail() {
  echo "$*" >&2
  exit 1
}

if [[ "$#" -ne 3 ]]; then
  echo "usage: $0 CANDIDATE EXPECTED_CURRENT EVIDENCE_STAGING" >&2
  exit 64
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo 'external evidence transaction must run as root' >&2
  exit 77
fi

sha256_file() {
  sha256sum -- "$1" | awk '{print $1}'
}

assert_root_owned_regular_file() {
  local file="$1"
  local label="$2"
  local mode
  if [[ ! -f "$file" || -L "$file" ]]; then
    fail "$label is missing or not a regular file: $file"
  fi
  [[ "$(stat -c '%u:%g' -- "$file")" == '0:0' ]] || fail "$label must be root:root: $file"
  mode="$(stat -c '%a' -- "$file")"
  (( (8#$mode & 8#022) == 0 )) || fail "$label must not be group/other writable: $file"
}

assert_root_owned_directory() {
  local directory="$1"
  local label="$2"
  if [[ ! -d "$directory" || -L "$directory" ]]; then
    fail "$label must be a real directory: $directory"
  fi
  [[ "$(stat -c '%u:%g' -- "$directory")" == '0:0' ]] || fail "$label must be root:root: $directory"
  find -P "$directory" -maxdepth 0 -perm /022 -print -quit | grep -q . &&
    fail "$label must not be group/other writable: $directory"
  return 0
}

assert_root_owned_tree() {
  local tree="$1"
  local label="$2"
  local invalid
  assert_root_owned_directory "$tree" "$label"
  invalid="$(find -P "$tree" -type l -print -quit)"
  [[ -z "$invalid" ]] || fail "$label must not contain symlinks: $invalid"
  invalid="$(find -P "$tree" \( ! -user root -o ! -group root \) -print -quit)"
  [[ -z "$invalid" ]] || fail "$label must be entirely root:root: $invalid"
  invalid="$(find -P "$tree" -perm /022 -print -quit)"
  [[ -z "$invalid" ]] || fail "$label must not be group/other writable: $invalid"
}

require_exact_sha256() {
  local file="$1"
  local expected="$2"
  local label="$3"
  local actual
  assert_root_owned_regular_file "$file" "$label"
  actual="$(sha256_file "$file")"
  [[ "$actual" == "$expected" ]] || fail "$label hash mismatch: expected=$expected actual=$actual"
}

tree_content_hash() {
  local tree="$1"
  (
    cd -- "$tree"
    local entry relative digest kind
    while IFS= read -r -d '' entry; do
      relative="${entry#./}"
      if [[ -f "$entry" ]]; then
        kind='file'
        digest="$(sha256_file "$entry")"
      elif [[ -d "$entry" ]]; then
        kind='directory'
        digest='-'
      else
        echo "unsupported evidence entry: $entry" >&2
        exit 1
      fi
      printf '%s\0%s\0%s\0' "$relative" "$kind" "$digest"
    done < <(find -P . -print0 | LC_ALL=C sort -z)
  ) | sha256sum | awk '{print $1}'
}

file_identity() {
  local file="$1"
  printf '%s|%s\n' "$(sha256_file "$file")" "$(stat -c '%d:%i:%y:%s:%a:%u:%g' -- "$file")"
}

assert_trusted_python() {
  local resolved_python
  [[ "$PYTHON_BINARY" == '/usr/bin/python3' && -x "$PYTHON_BINARY" ]] ||
    fail 'fixed Python launcher must be /usr/bin/python3 and executable'
  [[ "$(stat -c '%u:%g' -- "$PYTHON_BINARY")" == '0:0' ]] ||
    fail 'fixed Python launcher must be root:root'
  resolved_python="$(realpath -e -- "$PYTHON_BINARY")"
  case "$resolved_python" in /usr/bin/python3|/usr/bin/python3.*) ;; *) fail "fixed Python launcher resolves outside /usr/bin: $resolved_python" ;; esac
  assert_root_owned_regular_file "$resolved_python" 'fixed Python executable'
  [[ -x "$resolved_python" ]] || fail "fixed Python executable is not executable: $resolved_python"
}

atomic_exchange_directories() {
  local left="$1"
  local right="$2"
  if [[ ! -d "$left" || -L "$left" || ! -d "$right" || -L "$right" ]]; then
    echo 'atomic evidence exchange requires two real directories' >&2
    return 1
  fi
  if [[ "$(stat -c '%d' -- "$left")" != "$(stat -c '%d' -- "$right")" ]]; then
    echo 'atomic evidence exchange requires one filesystem' >&2
    return 1
  fi
  env -i PATH="$SAFE_PATH" LC_ALL=C "$PYTHON_BINARY" - "$left" "$right" <<'PYTHON'
import ctypes
import os
import sys

AT_FDCWD = -100
RENAME_EXCHANGE = 2
left, right = map(os.fsencode, sys.argv[1:3])
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
if renameat2(AT_FDCWD, left, AT_FDCWD, right, RENAME_EXCHANGE) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
PYTHON
}

assert_current_matches() {
  local actual
  actual="$(readlink -f -- "$CURRENT_LINK")" || fail "current release cannot be resolved: $CURRENT_LINK"
  [[ "$actual" == "$EXPECTED_CURRENT" ]] || {
    echo "current release changed: expected=$EXPECTED_CURRENT actual=$actual" >&2
    exit 73
  }
}

RELEASES_ROOT='/opt/moli-drama/releases'
CURRENT_LINK='/opt/moli-drama/current'
SHARED_ROOT='/opt/moli-drama/shared'
for required in "$RELEASES_ROOT" "$SHARED_ROOT"; do
  [[ -d "$required" ]] || fail "required production root is missing: $required"
done
RELEASES_ROOT="$(realpath -e -- "$RELEASES_ROOT")"
SHARED_ROOT="$(realpath -e -- "$SHARED_ROOT")"
readonly RELEASES_ROOT CURRENT_LINK SHARED_ROOT
assert_root_owned_regular_file "$NODE_BINARY" 'fixed Node.js executable'
[[ -x "$NODE_BINARY" ]] || fail "fixed Node.js executable is not executable: $NODE_BINARY"
assert_trusted_python

CANDIDATE="$(realpath -e -- "$1")"
EXPECTED_CURRENT="$(realpath -e -- "$2")"
EVIDENCE_STAGING="$(realpath -e -- "$3")"
case "$CANDIDATE" in "$RELEASES_ROOT"/*) ;; *) fail "candidate must be inside $RELEASES_ROOT" ;; esac
case "$EXPECTED_CURRENT" in "$RELEASES_ROOT"/*) ;; *) fail "expected current must be inside $RELEASES_ROOT" ;; esac
EVIDENCE_STAGING_ROOT="$SHARED_ROOT/release-evidence-staging"
case "$EVIDENCE_STAGING" in "$EVIDENCE_STAGING_ROOT"/*) ;; *) fail "evidence staging must be inside $EVIDENCE_STAGING_ROOT" ;; esac

GUARD_ROOT="$SHARED_ROOT/release-guard"
EVIDENCE_PARENT="$SHARED_ROOT/release-evidence"
EVIDENCE_TARGET="$EVIDENCE_PARENT/external-models-v1"
LOCK_FILE="$SHARED_ROOT/deploy.lock"
EXTERNAL_VERIFIER="$GUARD_ROOT/verify-external-model-release.js"
NEW_EXTERNAL_VERIFIER="$CANDIDATE/deploy/release-guard/verify-external-model-release.js"
ACTIVATOR="$GUARD_ROOT/activate-protected-release.sh"
UI_VERIFIER="$GUARD_ROOT/verify-protected-release.js"
SEQUENCE_VERIFIER="$GUARD_ROOT/verify-canvas-reference-sequence-contract.js"

assert_root_owned_tree "$EVIDENCE_STAGING" 'reviewed evidence staging'
assert_root_owned_regular_file "$EVIDENCE_STAGING/manifest.json" 'reviewed evidence manifest'
require_exact_sha256 "$NEW_EXTERNAL_VERIFIER" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'reviewed new external verifier'
env -i PATH="$SAFE_PATH" LC_ALL=C "$NODE_BINARY" --check "$NEW_EXTERNAL_VERIFIER"
REVIEWED_EVIDENCE_HASH="$(tree_content_hash "$EVIDENCE_STAGING")"

if [[ -L "$LOCK_FILE" ]]; then fail "deploy lock must not be a symlink: $LOCK_FILE"; fi
exec 9>>"$LOCK_FILE"
assert_root_owned_regular_file "$LOCK_FILE" 'deploy lock'
if ! flock -n 9; then
  echo 'another production release is in progress' >&2
  exit 75
fi

assert_current_matches
assert_root_owned_tree "$GUARD_ROOT" 'shared release guard'
assert_root_owned_tree "$EVIDENCE_TARGET" 'installed external evidence'
INSTALLED_EVIDENCE_HASH="$(tree_content_hash "$EVIDENCE_TARGET")"
require_exact_sha256 "$EXTERNAL_VERIFIER" "$EXPECTED_INSTALLED_EXTERNAL_VERIFIER_SHA256" 'installed external verifier'
require_exact_sha256 "$NEW_EXTERNAL_VERIFIER" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'reviewed new external verifier'
[[ "$(tree_content_hash "$EVIDENCE_STAGING")" == "$REVIEWED_EVIDENCE_HASH" ]] || fail 'reviewed evidence staging changed before transaction'

for untouched in "$ACTIVATOR" "$UI_VERIFIER" "$SEQUENCE_VERIFIER"; do
  assert_root_owned_regular_file "$untouched" "unchanged $(basename -- "$untouched")"
done
ACTIVATOR_IDENTITY="$(file_identity "$ACTIVATOR")"
UI_IDENTITY="$(file_identity "$UI_VERIFIER")"
SEQUENCE_IDENTITY="$(file_identity "$SEQUENCE_VERIFIER")"

env -i PATH="$SAFE_PATH" LC_ALL=C "$NODE_BINARY" - "$EVIDENCE_TARGET/manifest.json" "$EVIDENCE_STAGING/manifest.json" <<'NODE'
const fs = require('node:fs');
const [oldPath, nextPath] = process.argv.slice(2);
const oldManifest = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
const nextManifest = JSON.parse(fs.readFileSync(nextPath, 'utf8'));
const contract = 'external-model-release-evidence-manifest-v1';
if (oldManifest.contract_version !== contract || nextManifest.contract_version !== contract) {
  throw new Error('external evidence manifest contract mismatch');
}
const allowedChanges = new Set([
  'toapis-private-avatar-video-verification-v1',
  'toapis-wan3-video-real-verification-v1',
]);
for (const [name, record] of Object.entries(oldManifest.evidence || {})) {
  if (!(name in (nextManifest.evidence || {}))) throw new Error(`external evidence contract removed: ${name}`);
  if (!allowedChanges.has(name)
      && JSON.stringify(nextManifest.evidence[name]) !== JSON.stringify(record)) {
    throw new Error(`unrelated external evidence contract changed: ${name}`);
  }
}
for (const name of Object.keys(nextManifest.evidence || {})) {
  if (!(name in (oldManifest.evidence || {})) && !allowedChanges.has(name)) {
    throw new Error(`unreviewed external evidence contract added: ${name}`);
  }
}
for (const required of allowedChanges) {
  if (!(required in (nextManifest.evidence || {}))) throw new Error(`required refreshed contract missing: ${required}`);
}
NODE

env -i PATH="$SAFE_PATH" LC_ALL=C "$NODE_BINARY" "$NEW_EXTERNAL_VERIFIER" "$CANDIDATE" "$EVIDENCE_STAGING" "$EXPECTED_CURRENT"
assert_current_matches

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_ROOT="$GUARD_ROOT/backups/external-evidence-only-$stamp"
install -d -o root -g root -m 0700 "$BACKUP_ROOT"
install -o root -g root -m 0555 "$EXTERNAL_VERIFIER" "$BACKUP_ROOT/verify-external-model-release.js"
require_exact_sha256 "$BACKUP_ROOT/verify-external-model-release.js" "$EXPECTED_INSTALLED_EXTERNAL_VERIFIER_SHA256" 'backed-up external verifier'
AUDIT_FILE="$BACKUP_ROOT/transaction.audit"
printf 'candidate=%s\nexpected_current=%s\nold_external_sha256=%s\nnew_external_sha256=%s\nreviewed_evidence_sha256=%s\n' \
  "$CANDIDATE" "$EXPECTED_CURRENT" "$EXPECTED_INSTALLED_EXTERNAL_VERIFIER_SHA256" \
  "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" "$REVIEWED_EVIDENCE_HASH" > "$AUDIT_FILE"
chown root:root "$AUDIT_FILE"
chmod 0600 "$AUDIT_FILE"

TRANSACTION_ROOT="$(mktemp -d "$SHARED_ROOT/.external-evidence-only.XXXXXX")"
STAGED_EVIDENCE="$TRANSACTION_ROOT/external-models-v1"
EXTERNAL_NEXT="$GUARD_ROOT/.verify-external-model-release.js.next.$$"
EXTERNAL_ROLLBACK="$GUARD_ROOT/.verify-external-model-release.js.rollback.$$"
EVIDENCE_BACKUP="$BACKUP_ROOT/external-models-v1"
COMMITTED=0
EXTERNAL_REPLACED=0
EVIDENCE_EXCHANGED=0

cleanup_transaction() {
  local status="$?"
  local rollback_failed=0
  trap - EXIT INT TERM
  set +e
  if [[ "$status" -ne 0 && "$COMMITTED" -ne 1 ]]; then
    if [[ "$EXTERNAL_REPLACED" -eq 1 ]]; then
      install -o root -g root -m 0555 "$BACKUP_ROOT/verify-external-model-release.js" "$EXTERNAL_ROLLBACK" &&
        mv -Tf "$EXTERNAL_ROLLBACK" "$EXTERNAL_VERIFIER" || rollback_failed=1
    fi
    if [[ "$EVIDENCE_EXCHANGED" -eq 1 ]]; then
      atomic_exchange_directories "$EVIDENCE_TARGET" "$STAGED_EVIDENCE" || rollback_failed=1
    fi
    require_exact_sha256 "$EXTERNAL_VERIFIER" "$EXPECTED_INSTALLED_EXTERNAL_VERIFIER_SHA256" 'rolled-back external verifier' || rollback_failed=1
    [[ -d "$EVIDENCE_TARGET" ]] && assert_root_owned_tree "$EVIDENCE_TARGET" 'rolled-back external evidence' || rollback_failed=1
    [[ "$(tree_content_hash "$EVIDENCE_TARGET")" == "$INSTALLED_EVIDENCE_HASH" ]] || rollback_failed=1
    printf 'rollback_status=%s\n' "$rollback_failed" >> "$AUDIT_FILE"
  fi
  rm -f -- "$EXTERNAL_NEXT" "$EXTERNAL_ROLLBACK"
  if [[ -d "$TRANSACTION_ROOT" ]]; then rm -rf -- "$TRANSACTION_ROOT"; fi
  if [[ "$rollback_failed" -ne 0 ]]; then
    echo "external evidence rollback verification failed; backup=$BACKUP_ROOT" >&2
    exit 70
  fi
  exit "$status"
}
trap cleanup_transaction EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp -a -- "$EVIDENCE_STAGING" "$STAGED_EVIDENCE"
chown -R root:root "$STAGED_EVIDENCE"
find -P "$STAGED_EVIDENCE" -type d -exec chmod 0555 {} +
find -P "$STAGED_EVIDENCE" -type f -exec chmod 0444 {} +
assert_root_owned_tree "$STAGED_EVIDENCE" 'transaction evidence staging'
[[ "$(tree_content_hash "$STAGED_EVIDENCE")" == "$REVIEWED_EVIDENCE_HASH" ]] || fail 'transaction evidence hash mismatch'
sync -f "$STAGED_EVIDENCE"
install -o root -g root -m 0555 "$NEW_EXTERNAL_VERIFIER" "$EXTERNAL_NEXT"
require_exact_sha256 "$EXTERNAL_NEXT" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'prepared external verifier'
cp -a -- "$EVIDENCE_TARGET" "$EVIDENCE_BACKUP"
assert_root_owned_tree "$EVIDENCE_BACKUP" 'backed-up external evidence'
[[ "$(tree_content_hash "$EVIDENCE_BACKUP")" == "$INSTALLED_EVIDENCE_HASH" ]] || fail 'backed-up external evidence hash mismatch'

assert_current_matches
[[ "$(file_identity "$ACTIVATOR")" == "$ACTIVATOR_IDENTITY" ]] || fail 'activator changed during external evidence transaction'
[[ "$(file_identity "$UI_VERIFIER")" == "$UI_IDENTITY" ]] || fail 'UI verifier changed during external evidence transaction'
[[ "$(file_identity "$SEQUENCE_VERIFIER")" == "$SEQUENCE_IDENTITY" ]] || fail 'sequence verifier changed during external evidence transaction'

atomic_exchange_directories "$EVIDENCE_TARGET" "$STAGED_EVIDENCE"
EVIDENCE_EXCHANGED=1
EXTERNAL_REPLACED=1
mv -Tf "$EXTERNAL_NEXT" "$EXTERNAL_VERIFIER"

require_exact_sha256 "$EXTERNAL_VERIFIER" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'installed external verifier'
assert_root_owned_tree "$EVIDENCE_TARGET" 'installed external evidence'
[[ "$(tree_content_hash "$EVIDENCE_TARGET")" == "$REVIEWED_EVIDENCE_HASH" ]] || fail 'installed external evidence hash mismatch'
env -i PATH="$SAFE_PATH" LC_ALL=C "$NODE_BINARY" "$EXTERNAL_VERIFIER" "$CANDIDATE" "$EVIDENCE_TARGET" "$EXPECTED_CURRENT"
assert_current_matches
[[ "$(file_identity "$ACTIVATOR")" == "$ACTIVATOR_IDENTITY" ]] || fail 'activator changed during external evidence transaction'
[[ "$(file_identity "$UI_VERIFIER")" == "$UI_IDENTITY" ]] || fail 'UI verifier changed during external evidence transaction'
[[ "$(file_identity "$SEQUENCE_VERIFIER")" == "$SEQUENCE_IDENTITY" ]] || fail 'sequence verifier changed during external evidence transaction'

printf 'installed_evidence_sha256=%s\ntransaction_status=committed\n' "$REVIEWED_EVIDENCE_HASH" >> "$AUDIT_FILE"
COMMITTED=1
echo "external_model_verifier=$EXTERNAL_VERIFIER"
echo "external_model_evidence=$EVIDENCE_TARGET"
echo "external_model_backup=$BACKUP_ROOT"
echo "external_model_audit=$AUDIT_FILE"
