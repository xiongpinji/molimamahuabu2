#!/bin/bash -p
set -euo pipefail

readonly SAFE_PATH='/usr/sbin:/usr/bin:/sbin:/bin'
readonly NODE_BINARY='/usr/bin/node'
PATH="$SAFE_PATH"
export PATH
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH GLOBIGNORE
umask 077

readonly EXPECTED_OLD_ACTIVATOR_SHA256='ddd106c9f3e5d66537687e45d98d89b8c9112dd0038ab5d2e1daad61e5de0cf4'
readonly EXPECTED_UI_VERIFIER_SHA256='6ba3d9c34bebd27e96f7c431cc1eeb606bb9c624982e687632d16eccf6609b8b'
readonly EXPECTED_SEQUENCE_VERIFIER_SHA256='b0fce00c3155cb14c59962239abea8bdf6eb876b7f3b490458fc018be3c6adfe'
readonly EXPECTED_NEW_ACTIVATOR_SHA256='363ae14ae924b666f0cb9841de3d819a1ac6993e0a9b990b04382152e11cc752'
readonly EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256='aa7222b7e9459983c164c6e6daf0a3e32e5eb57123abab2ecf48711eff141e36'

fail() {
  echo "$*" >&2
  exit 1
}

if [[ "$#" -ne 4 ]]; then
  echo "usage: $0 SOURCE_RELEASE CANDIDATE EXPECTED_CURRENT EVIDENCE_STAGING" >&2
  exit 64
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo 'external model release guard rotation must run as root' >&2
  exit 77
fi

assert_root_owned_regular_file() {
  local file="$1"
  local label="${2:-required file}"
  local mode
  if [[ ! -f "$file" || -L "$file" ]]; then
    fail "$label is missing or not a regular file: $file"
  fi
  if [[ "$(stat -c '%u:%g' -- "$file")" != '0:0' ]]; then
    fail "$label must be root:root: $file"
  fi
  mode="$(stat -c '%a' -- "$file")"
  if (( (8#$mode & 8#022) != 0 )); then
    fail "$label must not be group/other writable: $file"
  fi
}

assert_root_owned_directory() {
  local directory="$1"
  local label="$2"
  if [[ ! -d "$directory" || -L "$directory" ]]; then
    fail "$label must be a real directory: $directory"
  fi
  if [[ "$(stat -c '%u:%g' -- "$directory")" != '0:0' ]] || find -P "$directory" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    fail "$label must be root:root and not group/other writable: $directory"
  fi
}

assert_trusted_node() {
  if [[ "$NODE_BINARY" != '/usr/bin/node' ]]; then
    fail 'release guard rotation Node.js path is not the fixed /usr/bin/node'
  fi
  assert_root_owned_regular_file "$NODE_BINARY" 'fixed Node.js executable'
  [[ -x "$NODE_BINARY" ]] || fail "fixed Node.js executable is not executable: $NODE_BINARY"
}

assert_root_owned_tree() {
  local tree="$1"
  local label="$2"
  local invalid
  if [[ ! -d "$tree" || -L "$tree" ]]; then
    fail "$label must be a real directory: $tree"
  fi
  invalid="$(find -P "$tree" -type l -print -quit)"
  [[ -z "$invalid" ]] || fail "$label must not contain symlinks: $invalid"
  invalid="$(find -P "$tree" \( ! -user root -o ! -group root \) -print -quit)"
  [[ -z "$invalid" ]] || fail "$label must be entirely root:root: $invalid"
  invalid="$(find -P "$tree" -perm /022 -print -quit)"
  [[ -z "$invalid" ]] || fail "$label must not be group/other writable: $invalid"
}

sha256_file() {
  sha256sum -- "$1" | awk '{print $1}'
}

require_exact_sha256() {
  local file="$1"
  local expected="$2"
  local label="${3:-$(basename -- "$file")}"
  local actual
  assert_root_owned_regular_file "$file" "$label"
  actual="$(sha256_file "$file")"
  if [[ "$actual" != "$expected" ]]; then
    fail "$label hash mismatch: expected=$expected actual=$actual"
  fi
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

assert_current_matches() {
  local actual_current
  if ! actual_current="$(readlink -f -- "$CURRENT_LINK")"; then
    fail "current release link cannot be resolved: $CURRENT_LINK"
  fi
  if [[ "$actual_current" != "$EXPECTED_CURRENT" ]]; then
    echo "current release changed: expected=$EXPECTED_CURRENT actual=$actual_current" >&2
    exit 73
  fi
}

assert_trusted_node

RELEASES_ROOT='/opt/moli-drama/releases'
CURRENT_LINK='/opt/moli-drama/current'
SHARED_ROOT='/opt/moli-drama/shared'
if [[ ! -d "$RELEASES_ROOT" || ! -d "$SHARED_ROOT" ]]; then
  fail 'release and shared roots must both exist'
fi
RELEASES_ROOT="$(realpath -e -- "$RELEASES_ROOT")"
SHARED_ROOT="$(realpath -e -- "$SHARED_ROOT")"
readonly RELEASES_ROOT CURRENT_LINK SHARED_ROOT
assert_root_owned_directory "$(dirname -- "$CURRENT_LINK")" 'deployment root'
assert_root_owned_directory "$RELEASES_ROOT" 'releases root'
assert_root_owned_directory "$SHARED_ROOT" 'shared root'
EVIDENCE_STAGING_ROOT="$SHARED_ROOT/release-evidence-staging"
if [[ ! -d "$EVIDENCE_STAGING_ROOT" || -L "$EVIDENCE_STAGING_ROOT" ]]; then
  fail "root-owned evidence staging root is missing: $EVIDENCE_STAGING_ROOT"
fi
EVIDENCE_STAGING_ROOT="$(realpath -e -- "$EVIDENCE_STAGING_ROOT")"

for input_directory in "$1" "$2" "$3" "$4"; do
  [[ -d "$input_directory" ]] || fail "rotation input must be a directory: $input_directory"
done
SOURCE_RELEASE="$(realpath -e -- "$1")"
CANDIDATE="$(realpath -e -- "$2")"
EXPECTED_CURRENT="$(realpath -e -- "$3")"
EVIDENCE_STAGING="$(realpath -e -- "$4")"

for release in "$SOURCE_RELEASE" "$CANDIDATE" "$EXPECTED_CURRENT"; do
  case "$release" in
    "$RELEASES_ROOT"/*) ;;
    *) fail "release input must be inside $RELEASES_ROOT: $release" ;;
  esac
done
if [[ "$SOURCE_RELEASE" != "$CANDIDATE" ]]; then
  fail 'source release must equal candidate for this reviewed one-time guard rotation'
fi
case "$EVIDENCE_STAGING" in
  "$EVIDENCE_STAGING_ROOT"/*) ;;
  *) fail "evidence staging must be inside $EVIDENCE_STAGING_ROOT" ;;
esac

SHARED_GUARD_ROOT="$SHARED_ROOT/release-guard"
LOCK_FILE="$SHARED_ROOT/deploy.lock"
OLD_ACTIVATOR="$SHARED_GUARD_ROOT/activate-protected-release.sh"
UI_VERIFIER="$SHARED_GUARD_ROOT/verify-protected-release.js"
SEQUENCE_VERIFIER="$SHARED_GUARD_ROOT/verify-canvas-reference-sequence-contract.js"
EXTERNAL_MODEL_VERIFIER="$SHARED_GUARD_ROOT/verify-external-model-release.js"
EVIDENCE_PARENT="$SHARED_ROOT/release-evidence"
EVIDENCE_TARGET="$EVIDENCE_PARENT/external-models-v1"
NEW_ACTIVATOR_SOURCE="$SOURCE_RELEASE/deploy/release-guard/activate-protected-release.sh"
NEW_EXTERNAL_VERIFIER_SOURCE="$SOURCE_RELEASE/deploy/release-guard/verify-external-model-release.js"

assert_root_owned_tree "$EVIDENCE_STAGING_ROOT" 'evidence staging root'
assert_root_owned_tree "$EVIDENCE_STAGING" 'reviewed evidence staging'
assert_root_owned_regular_file "$EVIDENCE_STAGING/manifest.json" 'reviewed evidence manifest'
require_exact_sha256 "$NEW_ACTIVATOR_SOURCE" "$EXPECTED_NEW_ACTIVATOR_SHA256" 'reviewed new activator'
require_exact_sha256 "$NEW_EXTERNAL_VERIFIER_SOURCE" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'reviewed new external model verifier'
REVIEWED_EVIDENCE_HASH="$(tree_content_hash "$EVIDENCE_STAGING")"

if [[ ! -d "$SHARED_GUARD_ROOT" || -L "$SHARED_GUARD_ROOT" ]]; then
  fail 'shared release guard directory is missing or invalid'
fi
assert_root_owned_tree "$SHARED_GUARD_ROOT" 'shared release guard'
if [[ -L "$LOCK_FILE" ]]; then
  fail "deploy lock must not be a symlink: $LOCK_FILE"
fi
exec 9>>"$LOCK_FILE"
assert_root_owned_regular_file "$LOCK_FILE" 'deploy lock'
if ! flock -n 9; then
  echo 'another production release is in progress' >&2
  exit 75
fi

assert_current_matches
require_exact_sha256 "$OLD_ACTIVATOR" "$EXPECTED_OLD_ACTIVATOR_SHA256" 'activate-protected-release.sh'
require_exact_sha256 "$UI_VERIFIER" "$EXPECTED_UI_VERIFIER_SHA256" 'verify-protected-release.js'
require_exact_sha256 "$SEQUENCE_VERIFIER" "$EXPECTED_SEQUENCE_VERIFIER_SHA256" 'verify-canvas-reference-sequence-contract.js'
require_exact_sha256 "$NEW_ACTIVATOR_SOURCE" "$EXPECTED_NEW_ACTIVATOR_SHA256" 'reviewed new activator'
require_exact_sha256 "$NEW_EXTERNAL_VERIFIER_SOURCE" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'reviewed new external model verifier'
if [[ "$(tree_content_hash "$EVIDENCE_STAGING")" != "$REVIEWED_EVIDENCE_HASH" ]]; then
  fail 'reviewed evidence staging changed before rotation'
fi

EXTERNAL_EXISTED=0
OLD_EXTERNAL_HASH=''
if [[ -e "$EXTERNAL_MODEL_VERIFIER" || -L "$EXTERNAL_MODEL_VERIFIER" ]]; then
  assert_root_owned_regular_file "$EXTERNAL_MODEL_VERIFIER" 'installed external model verifier'
  EXTERNAL_EXISTED=1
  OLD_EXTERNAL_HASH="$(sha256_file "$EXTERNAL_MODEL_VERIFIER")"
fi
EVIDENCE_EXISTED=0
OLD_EVIDENCE_HASH=''
if [[ -e "$EVIDENCE_TARGET" || -L "$EVIDENCE_TARGET" ]]; then
  assert_root_owned_tree "$EVIDENCE_TARGET" 'installed external model evidence'
  EVIDENCE_EXISTED=1
  OLD_EVIDENCE_HASH="$(tree_content_hash "$EVIDENCE_TARGET")"
fi

rotation_stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_ROOT="$SHARED_GUARD_ROOT/backups/external-model-guard-$rotation_stamp"
install -d -o root -g root -m 0700 "$BACKUP_ROOT"
ROTATION_AUDIT="$BACKUP_ROOT/rotation.audit"
: > "$ROTATION_AUDIT"
chown root:root "$ROTATION_AUDIT"
chmod 0600 "$ROTATION_AUDIT"
printf 'source_release=%s\ncandidate=%s\nexpected_current=%s\nreviewed_evidence_sha256=%s\nold_external_sha256=%s\nold_evidence_sha256=%s\n' \
  "$SOURCE_RELEASE" "$CANDIDATE" "$EXPECTED_CURRENT" "$REVIEWED_EVIDENCE_HASH" "$OLD_EXTERNAL_HASH" "$OLD_EVIDENCE_HASH" > "$ROTATION_AUDIT"

install -o root -g root -m 0555 "$OLD_ACTIVATOR" "$BACKUP_ROOT/activate-protected-release.sh"
install -o root -g root -m 0555 "$UI_VERIFIER" "$BACKUP_ROOT/verify-protected-release.js"
install -o root -g root -m 0555 "$SEQUENCE_VERIFIER" "$BACKUP_ROOT/verify-canvas-reference-sequence-contract.js"
require_exact_sha256 "$BACKUP_ROOT/activate-protected-release.sh" "$EXPECTED_OLD_ACTIVATOR_SHA256" 'backed-up old activator'
require_exact_sha256 "$BACKUP_ROOT/verify-protected-release.js" "$EXPECTED_UI_VERIFIER_SHA256" 'backed-up UI verifier'
require_exact_sha256 "$BACKUP_ROOT/verify-canvas-reference-sequence-contract.js" "$EXPECTED_SEQUENCE_VERIFIER_SHA256" 'backed-up sequence verifier'
if [[ "$EXTERNAL_EXISTED" -eq 1 ]]; then
  install -o root -g root -m 0555 "$EXTERNAL_MODEL_VERIFIER" "$BACKUP_ROOT/verify-external-model-release.js"
  require_exact_sha256 "$BACKUP_ROOT/verify-external-model-release.js" "$OLD_EXTERNAL_HASH" 'backed-up external model verifier'
fi

STAGING_ROOT="$(mktemp -d "$SHARED_ROOT/.external-model-release-guard-rotation.XXXXXX")"
STAGED_SHARED_ROOT="$STAGING_ROOT/shared"
STAGED_GUARD_ROOT="$STAGED_SHARED_ROOT/release-guard"
STAGED_EVIDENCE_ROOT="$STAGED_SHARED_ROOT/release-evidence/external-models-v1"
ACTIVATOR_HARNESS="$STAGING_ROOT/activate-protected-release.verify-only-harness.sh"
EXTERNAL_NEXT="$SHARED_GUARD_ROOT/.verify-external-model-release.js.next.$$"
ACTIVATOR_NEXT="$SHARED_GUARD_ROOT/.activate-protected-release.sh.next.$$"
EVIDENCE_BACKUP="$BACKUP_ROOT/external-models-v1"
COMMITTED=0
ACTIVATOR_REPLACED=0
EXTERNAL_REPLACED=0
EVIDENCE_OLD_MOVED=0
EVIDENCE_NEW_INSTALLED=0

cleanup_rotation() {
  local status="$?"
  local rollback_failed=0
  trap - EXIT INT TERM
  set +e
  if [[ "$status" -ne 0 && "$COMMITTED" -ne 1 ]]; then
    if [[ "$ACTIVATOR_REPLACED" -eq 1 ]]; then
      if ! install -o root -g root -m 0555 "$BACKUP_ROOT/activate-protected-release.sh" "$ACTIVATOR_NEXT.rollback" ||
        ! mv -Tf "$ACTIVATOR_NEXT.rollback" "$OLD_ACTIVATOR"; then
        rollback_failed=1
      fi
    fi
    if [[ "$EXTERNAL_REPLACED" -eq 1 ]]; then
      if [[ "$EXTERNAL_EXISTED" -eq 1 ]]; then
        if ! install -o root -g root -m 0555 "$BACKUP_ROOT/verify-external-model-release.js" "$EXTERNAL_NEXT.rollback" ||
          ! mv -Tf "$EXTERNAL_NEXT.rollback" "$EXTERNAL_MODEL_VERIFIER"; then
          rollback_failed=1
        fi
      elif [[ -e "$EXTERNAL_MODEL_VERIFIER" || -L "$EXTERNAL_MODEL_VERIFIER" ]]; then
        mv -Tf "$EXTERNAL_MODEL_VERIFIER" "$STAGING_ROOT/failed-new-external-verifier" || rollback_failed=1
      fi
    fi
    if [[ "$EVIDENCE_NEW_INSTALLED" -eq 1 && -d "$EVIDENCE_TARGET" ]]; then
      mv -T "$EVIDENCE_TARGET" "$STAGING_ROOT/failed-new-evidence" || rollback_failed=1
    fi
    if [[ "$EVIDENCE_OLD_MOVED" -eq 1 && -d "$EVIDENCE_BACKUP" ]]; then
      mv -T "$EVIDENCE_BACKUP" "$EVIDENCE_TARGET" || rollback_failed=1
    fi

    if [[ ! -f "$OLD_ACTIVATOR" || -L "$OLD_ACTIVATOR" || "$(stat -c '%u:%g' -- "$OLD_ACTIVATOR" 2>/dev/null)" != '0:0' || "$(sha256_file "$OLD_ACTIVATOR" 2>/dev/null)" != "$EXPECTED_OLD_ACTIVATOR_SHA256" ]]; then
      rollback_failed=1
    fi
    if [[ ! -f "$UI_VERIFIER" || -L "$UI_VERIFIER" || "$(stat -c '%u:%g' -- "$UI_VERIFIER" 2>/dev/null)" != '0:0' || "$(sha256_file "$UI_VERIFIER" 2>/dev/null)" != "$EXPECTED_UI_VERIFIER_SHA256" ]]; then
      rollback_failed=1
    fi
    if [[ ! -f "$SEQUENCE_VERIFIER" || -L "$SEQUENCE_VERIFIER" || "$(stat -c '%u:%g' -- "$SEQUENCE_VERIFIER" 2>/dev/null)" != '0:0' || "$(sha256_file "$SEQUENCE_VERIFIER" 2>/dev/null)" != "$EXPECTED_SEQUENCE_VERIFIER_SHA256" ]]; then
      rollback_failed=1
    fi
    if [[ "$EXTERNAL_EXISTED" -eq 1 ]]; then
      if [[ ! -f "$EXTERNAL_MODEL_VERIFIER" || -L "$EXTERNAL_MODEL_VERIFIER" || "$(stat -c '%u:%g' -- "$EXTERNAL_MODEL_VERIFIER" 2>/dev/null)" != '0:0' || "$(sha256_file "$EXTERNAL_MODEL_VERIFIER" 2>/dev/null)" != "$OLD_EXTERNAL_HASH" ]]; then
        rollback_failed=1
      fi
    elif [[ -e "$EXTERNAL_MODEL_VERIFIER" || -L "$EXTERNAL_MODEL_VERIFIER" ]]; then
      rollback_failed=1
    fi
    if [[ "$EVIDENCE_EXISTED" -eq 1 ]]; then
      if [[ ! -d "$EVIDENCE_TARGET" || -L "$EVIDENCE_TARGET" ]] ||
        [[ -n "$(find -P "$EVIDENCE_TARGET" \( -type l -o ! -user root -o ! -group root -o -perm /022 \) -print -quit 2>/dev/null)" ]] ||
        [[ "$(tree_content_hash "$EVIDENCE_TARGET" 2>/dev/null)" != "$OLD_EVIDENCE_HASH" ]]; then
        rollback_failed=1
      fi
    elif [[ -e "$EVIDENCE_TARGET" || -L "$EVIDENCE_TARGET" ]]; then
      rollback_failed=1
    fi
    printf 'rollback_status=%s\n' "$rollback_failed" >> "$ROTATION_AUDIT"
  fi
  rm -f -- "$EXTERNAL_NEXT" "$ACTIVATOR_NEXT" "$ACTIVATOR_NEXT.rollback" "$EXTERNAL_NEXT.rollback"
  if [[ -n "${STAGING_ROOT:-}" && -d "$STAGING_ROOT" ]]; then
    case "$(realpath -e -- "$STAGING_ROOT")" in
      "$SHARED_ROOT"/.external-model-release-guard-rotation.*) rm -rf -- "$STAGING_ROOT" ;;
      *) echo "refusing to clean unexpected rotation staging path: $STAGING_ROOT" >&2; rollback_failed=1 ;;
    esac
  fi
  if [[ "$rollback_failed" -ne 0 ]]; then
    echo "external model release guard rollback verification failed; backups retained at $BACKUP_ROOT" >&2
    exit 70
  fi
  exit "$status"
}
trap cleanup_rotation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -d -o root -g root -m 0755 "$STAGED_GUARD_ROOT" "$STAGED_EVIDENCE_ROOT"
install -o root -g root -m 0555 "$UI_VERIFIER" "$STAGED_GUARD_ROOT/verify-protected-release.js"
install -o root -g root -m 0555 "$SEQUENCE_VERIFIER" "$STAGED_GUARD_ROOT/verify-canvas-reference-sequence-contract.js"
install -o root -g root -m 0555 "$NEW_EXTERNAL_VERIFIER_SOURCE" "$STAGED_GUARD_ROOT/verify-external-model-release.js"
install -o root -g root -m 0555 "$NEW_ACTIVATOR_SOURCE" "$STAGED_GUARD_ROOT/activate-protected-release.sh"
cp -a -- "$EVIDENCE_STAGING/." "$STAGED_EVIDENCE_ROOT/"
chown -R root:root "$STAGED_SHARED_ROOT"
find -P "$STAGED_EVIDENCE_ROOT" -type d -exec chmod 0555 {} +
find -P "$STAGED_EVIDENCE_ROOT" -type f -exec chmod 0444 {} +
assert_root_owned_tree "$STAGED_EVIDENCE_ROOT" 'staged reviewed evidence'
[[ "$(tree_content_hash "$STAGED_EVIDENCE_ROOT")" == "$REVIEWED_EVIDENCE_HASH" ]] || fail 'staged evidence hash differs from reviewed evidence'
require_exact_sha256 "$STAGED_GUARD_ROOT/activate-protected-release.sh" "$EXPECTED_NEW_ACTIVATOR_SHA256" 'staged new activator'
require_exact_sha256 "$STAGED_GUARD_ROOT/verify-external-model-release.js" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'staged new external verifier'

/bin/bash -n "$STAGED_GUARD_ROOT/activate-protected-release.sh"
env -i PATH="$SAFE_PATH" LC_ALL=C "$NODE_BINARY" --check "$STAGED_GUARD_ROOT/verify-external-model-release.js"
env -i PATH="$SAFE_PATH" LC_ALL=C "$NODE_BINARY" - \
  "$STAGED_GUARD_ROOT/activate-protected-release.sh" "$ACTIVATOR_HARNESS" \
  "$RELEASES_ROOT" "$CURRENT_LINK" "$STAGED_SHARED_ROOT" <<'NODE'
const fs = require('node:fs');

const [sourcePath, harnessPath, releasesRoot, currentLink, sharedRoot] = process.argv.slice(2);
let source = fs.readFileSync(sourcePath, 'utf8');
const replacements = new Map([
  ["RELEASES_ROOT='/opt/moli-drama/releases'", `RELEASES_ROOT='${releasesRoot}'`],
  ["CURRENT_LINK='/opt/moli-drama/current'", `CURRENT_LINK='${currentLink}'`],
  ["SHARED_ROOT='/opt/moli-drama/shared'", `SHARED_ROOT='${sharedRoot}'`],
]);
for (const [productionLine, harnessLine] of replacements) {
  if (source.split(productionLine).length !== 2) {
    throw new Error(`verify-only harness expected exactly one fixed production root: ${productionLine}`);
  }
  source = source.replace(productionLine, harnessLine);
}
fs.writeFileSync(harnessPath, source, { encoding: 'utf8', flag: 'wx', mode: 0o500 });
NODE
chown root:root "$ACTIVATOR_HARNESS"
chmod 0500 "$ACTIVATOR_HARNESS"
/bin/bash -n "$ACTIVATOR_HARNESS"
env -i \
  PATH="$SAFE_PATH" \
  LC_ALL=C \
  PROTECTED_RELEASE_VERIFY_ONLY=1 \
  /bin/bash -p "$ACTIVATOR_HARNESS" "$CANDIDATE" "$EXPECTED_CURRENT"

assert_current_matches
require_exact_sha256 "$OLD_ACTIVATOR" "$EXPECTED_OLD_ACTIVATOR_SHA256" 'activate-protected-release.sh'
require_exact_sha256 "$UI_VERIFIER" "$EXPECTED_UI_VERIFIER_SHA256" 'verify-protected-release.js'
require_exact_sha256 "$SEQUENCE_VERIFIER" "$EXPECTED_SEQUENCE_VERIFIER_SHA256" 'verify-canvas-reference-sequence-contract.js'
require_exact_sha256 "$NEW_ACTIVATOR_SOURCE" "$EXPECTED_NEW_ACTIVATOR_SHA256" 'reviewed new activator'
require_exact_sha256 "$NEW_EXTERNAL_VERIFIER_SOURCE" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'reviewed new external verifier'
[[ "$(tree_content_hash "$EVIDENCE_STAGING")" == "$REVIEWED_EVIDENCE_HASH" ]] || fail 'reviewed evidence changed after staged verification'

install -d -o root -g root -m 0755 "$EVIDENCE_PARENT"
install -o root -g root -m 0555 "$STAGED_GUARD_ROOT/verify-external-model-release.js" "$EXTERNAL_NEXT"
install -o root -g root -m 0555 "$STAGED_GUARD_ROOT/activate-protected-release.sh" "$ACTIVATOR_NEXT"
require_exact_sha256 "$EXTERNAL_NEXT" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'prepared external verifier'
require_exact_sha256 "$ACTIVATOR_NEXT" "$EXPECTED_NEW_ACTIVATOR_SHA256" 'prepared activator'

if [[ "$EVIDENCE_EXISTED" -eq 1 ]]; then
  EVIDENCE_OLD_MOVED=1
  mv -T "$EVIDENCE_TARGET" "$EVIDENCE_BACKUP"
  assert_root_owned_tree "$EVIDENCE_BACKUP" 'atomically backed-up old evidence'
  [[ "$(tree_content_hash "$EVIDENCE_BACKUP")" == "$OLD_EVIDENCE_HASH" ]] || fail 'atomically backed-up old evidence hash mismatch'
fi
EVIDENCE_NEW_INSTALLED=1
mv -T "$STAGED_EVIDENCE_ROOT" "$EVIDENCE_TARGET"
assert_root_owned_tree "$EVIDENCE_TARGET" 'installed reviewed evidence'
[[ "$(tree_content_hash "$EVIDENCE_TARGET")" == "$REVIEWED_EVIDENCE_HASH" ]] || fail 'installed reviewed evidence hash mismatch'

EXTERNAL_REPLACED=1
mv -Tf "$EXTERNAL_NEXT" "$EXTERNAL_MODEL_VERIFIER"
require_exact_sha256 "$EXTERNAL_MODEL_VERIFIER" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'installed external model verifier'
env -i PATH="$SAFE_PATH" LC_ALL=C "$NODE_BINARY" "$EXTERNAL_MODEL_VERIFIER" "$CANDIDATE" "$EVIDENCE_TARGET"
assert_root_owned_tree "$EVIDENCE_TARGET" 'post-verifier installed evidence'
[[ "$(tree_content_hash "$EVIDENCE_TARGET")" == "$REVIEWED_EVIDENCE_HASH" ]] || fail 'installed evidence changed during final verifier execution'

assert_current_matches
require_exact_sha256 "$OLD_ACTIVATOR" "$EXPECTED_OLD_ACTIVATOR_SHA256" 'activate-protected-release.sh'
require_exact_sha256 "$UI_VERIFIER" "$EXPECTED_UI_VERIFIER_SHA256" 'verify-protected-release.js'
require_exact_sha256 "$SEQUENCE_VERIFIER" "$EXPECTED_SEQUENCE_VERIFIER_SHA256" 'verify-canvas-reference-sequence-contract.js'
ACTIVATOR_REPLACED=1
mv -Tf "$ACTIVATOR_NEXT" "$OLD_ACTIVATOR"

require_exact_sha256 "$OLD_ACTIVATOR" "$EXPECTED_NEW_ACTIVATOR_SHA256" 'installed new activator'
require_exact_sha256 "$EXTERNAL_MODEL_VERIFIER" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" 'installed new external model verifier'
assert_root_owned_tree "$EVIDENCE_TARGET" 'installed reviewed evidence'
[[ "$(tree_content_hash "$EVIDENCE_TARGET")" == "$REVIEWED_EVIDENCE_HASH" ]] || fail 'installed reviewed evidence changed before commit'
require_exact_sha256 "$UI_VERIFIER" "$EXPECTED_UI_VERIFIER_SHA256" 'unchanged UI verifier'
require_exact_sha256 "$SEQUENCE_VERIFIER" "$EXPECTED_SEQUENCE_VERIFIER_SHA256" 'unchanged sequence verifier'
assert_current_matches

printf 'new_activator_sha256=%s\nnew_external_verifier_sha256=%s\ninstalled_evidence_sha256=%s\nrotation_status=committed\n' \
  "$EXPECTED_NEW_ACTIVATOR_SHA256" "$EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256" "$REVIEWED_EVIDENCE_HASH" >> "$ROTATION_AUDIT"
COMMITTED=1

echo "external_model_release_guard_rotated=$SHARED_GUARD_ROOT"
echo "external_model_release_evidence=$EVIDENCE_TARGET"
echo "external_model_release_guard_backup=$BACKUP_ROOT"
echo "external_model_release_guard_audit=$ROTATION_AUDIT"
