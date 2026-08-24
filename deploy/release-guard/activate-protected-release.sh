#!/bin/bash -p
set -euo pipefail

readonly SAFE_PATH='/usr/sbin:/usr/bin:/sbin:/bin'
readonly NODE_BINARY='/usr/bin/node'
readonly PYTHON_BINARY='/usr/bin/python3'
readonly SYSTEMCTL_BINARY='/usr/bin/systemctl'
readonly CURL_BINARY='/usr/bin/curl'
readonly JOURNALCTL_BINARY='/usr/bin/journalctl'
readonly PS_BINARY='/usr/bin/ps'
readonly SLEEP_BINARY='/usr/bin/sleep'
PATH="$SAFE_PATH"
export PATH
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH GLOBIGNORE
umask 077

fail() {
  local status="$1"
  shift
  echo "$*" >&2
  exit "$status"
}

if [[ "$#" -ne 2 ]]; then
  fail 64 "usage: $0 CANDIDATE_RELEASE EXPECTED_CURRENT"
fi
if [[ "$(id -u)" -ne 0 ]]; then
  fail 77 'protected release activation must run as root'
fi

readonly VERIFY_ONLY_REQUESTED="${PROTECTED_RELEASE_VERIFY_ONLY:-0}"
if [[ "$VERIFY_ONLY_REQUESTED" != '0' && "$VERIFY_ONLY_REQUESTED" != '1' ]]; then
  fail 64 'PROTECTED_RELEASE_VERIFY_ONLY must be exactly 0 or 1'
fi
RELEASES_ROOT='/opt/moli-drama/releases'
CURRENT_LINK='/opt/moli-drama/current'
SHARED_ROOT='/opt/moli-drama/shared'

if [[ ! -d "$RELEASES_ROOT" || ! -d "$SHARED_ROOT" ]]; then
  fail 66 'release and shared roots must both exist'
fi
RELEASES_ROOT="$(realpath -e -- "$RELEASES_ROOT")"
SHARED_ROOT="$(realpath -e -- "$SHARED_ROOT")"
readonly RELEASES_ROOT CURRENT_LINK SHARED_ROOT
SHARED_GUARD_ROOT="$SHARED_ROOT/release-guard"
SHARED_VERIFIER="$SHARED_GUARD_ROOT/verify-protected-release.js"
SEQUENCE_VERIFIER="$SHARED_GUARD_ROOT/verify-canvas-reference-sequence-contract.js"
EXTERNAL_MODEL_VERIFIER="$SHARED_GUARD_ROOT/verify-external-model-release.js"
EXTERNAL_MODEL_EVIDENCE_ROOT="$SHARED_ROOT/release-evidence/external-models-v1"
PRODUCTION_ENV="$SHARED_ROOT/production.env"
LOCK_FILE="$SHARED_ROOT/deploy.lock"
AUDIT_ROOT="$SHARED_ROOT/release-audit"
AI_MUSIC_SERVER='/opt/moli-mama/server/server.js'
AI_MUSIC_WORKER='/opt/moli-mama/server/worker.js'

if [[ ! -d "$1" || ! -d "$2" ]]; then
  fail 66 'candidate and expected current must both be directories'
fi
CANDIDATE="$(realpath -e -- "$1")"
EXPECTED_CURRENT="$(realpath -e -- "$2")"

case "$CANDIDATE" in
  "$RELEASES_ROOT"/*) ;;
  *) fail 65 "candidate must be inside $RELEASES_ROOT" ;;
esac
case "$EXPECTED_CURRENT" in
  "$RELEASES_ROOT"/*) ;;
  *) fail 65 "expected current must be inside $RELEASES_ROOT" ;;
esac
if [[ "$CANDIDATE" == *$'\n'* || "$CANDIDATE" == *$'\r'* || "$EXPECTED_CURRENT" == *$'\n'* || "$EXPECTED_CURRENT" == *$'\r'* ]]; then
  fail 65 'release paths must not contain line breaks'
fi

assert_root_owned_regular_file() {
  local file="$1"
  local label="${2:-protected release file}"
  local mode
  if [[ ! -f "$file" || -L "$file" ]]; then
    fail 69 "$label is missing or not a regular file: $file"
  fi
  if [[ "$(stat -c '%u:%g' -- "$file")" != '0:0' ]]; then
    fail 69 "$label must be root:root: $file"
  fi
  mode="$(stat -c '%a' -- "$file")"
  if (( (8#$mode & 8#022) != 0 )); then
    fail 69 "$label must not be group/other writable: $file"
  fi
}

assert_root_owned_directory() {
  local directory="$1"
  local label="$2"
  if [[ ! -d "$directory" || -L "$directory" ]]; then
    fail 69 "$label must be a real directory: $directory"
  fi
  if [[ "$(stat -c '%u:%g' -- "$directory")" != '0:0' ]] || find -P "$directory" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    fail 69 "$label must be root:root and not group/other writable: $directory"
  fi
}

assert_trusted_node() {
  if [[ "$NODE_BINARY" != '/usr/bin/node' ]]; then
    fail 69 'release guard Node.js path is not the fixed /usr/bin/node'
  fi
  assert_root_owned_regular_file "$NODE_BINARY" 'fixed Node.js executable'
  if [[ ! -x "$NODE_BINARY" ]]; then
    fail 69 "fixed Node.js executable is not executable: $NODE_BINARY"
  fi
}

assert_trusted_python() {
  local resolved_python
  if [[ "$PYTHON_BINARY" != '/usr/bin/python3' || ! -x "$PYTHON_BINARY" ]]; then
    fail 69 'release guard Python path is not the fixed executable /usr/bin/python3'
  fi
  if [[ "$(stat -c '%u:%g' -- "$PYTHON_BINARY")" != '0:0' ]]; then
    fail 69 'fixed Python launcher must be root:root: /usr/bin/python3'
  fi
  resolved_python="$(realpath -e -- "$PYTHON_BINARY")"
  case "$resolved_python" in
    /usr/bin/python3|/usr/bin/python3.*) ;;
    *) fail 69 "fixed Python launcher resolves outside /usr/bin: $resolved_python" ;;
  esac
  assert_root_owned_regular_file "$resolved_python" 'fixed Python executable'
  [[ -x "$resolved_python" ]] || fail 69 "fixed Python executable is not executable: $resolved_python"
}

assert_root_owned_tree_without_symlinks() {
  local tree="$1"
  local label="$2"
  local invalid
  if [[ ! -d "$tree" || -L "$tree" ]]; then
    fail 69 "$label root is missing or invalid: $tree"
  fi
  invalid="$(find -P "$tree" -type l -print -quit)"
  if [[ -n "$invalid" ]]; then
    fail 69 "$label must not contain symlinks: $invalid"
  fi
  invalid="$(find -P "$tree" \( ! -user root -o ! -group root \) -print -quit)"
  if [[ -n "$invalid" ]]; then
    fail 69 "$label must be entirely root:root: $invalid"
  fi
  invalid="$(find -P "$tree" -perm /022 -print -quit)"
  if [[ -n "$invalid" ]]; then
    fail 69 "$label must not be group/other writable: $invalid"
  fi
}

assert_root_owned_evidence_tree() {
  assert_root_owned_tree_without_symlinks "$EXTERNAL_MODEL_EVIDENCE_ROOT" 'shared external model evidence'
}

assert_current_matches() {
  local actual_current
  if ! actual_current="$(readlink -f -- "$CURRENT_LINK")"; then
    fail 73 "current release link cannot be resolved: $CURRENT_LINK"
  fi
  if [[ "$actual_current" != "$EXPECTED_CURRENT" ]]; then
    fail 73 "current release changed: expected=$EXPECTED_CURRENT actual=$actual_current"
  fi
}

assert_current_is_candidate() {
  local actual_current
  if ! actual_current="$(readlink -f -- "$CURRENT_LINK")"; then
    fail 73 "current release link cannot be resolved after activation: $CURRENT_LINK"
  fi
  if [[ "$actual_current" != "$CANDIDATE" ]]; then
    fail 73 "current release changed after activation: expected=$CANDIDATE actual=$actual_current"
  fi
}

assert_candidate_tree_secure() {
  local entry owner mode resolved

  if ! find -P "$CANDIDATE" -print0 >/dev/null; then
    fail 65 'candidate lexical tree cannot be traversed safely'
  fi
  if ! while IFS= read -r -d '' entry; do
    owner="$(stat -c '%u:%g' -- "$entry")"
    if [[ "$owner" != '0:0' ]]; then
      echo "candidate entry must be root:root: $entry" >&2
      exit 1
    fi
    if [[ ! -L "$entry" ]]; then
      mode="$(stat -c '%a' -- "$entry")"
      if (( (8#$mode & 8#022) != 0 )); then
        echo "candidate entry must not be group/other writable: $entry" >&2
        exit 1
      fi
    fi
  done < <(find -P "$CANDIDATE" -print0); then
    fail 65 'candidate lexical tree ownership or permissions are unsafe'
  fi

  if ! while IFS= read -r -d '' entry; do
    if ! resolved="$(realpath -e -- "$entry")"; then
      echo "candidate contains a broken symlink path: $entry" >&2
      exit 1
    fi
    case "$resolved" in
      "$RELEASES_ROOT"|"$RELEASES_ROOT"/*) ;;
      *) echo "candidate symlink points outside releases root: $entry -> $resolved" >&2; exit 1 ;;
    esac
    owner="$(stat -Lc '%u:%g' -- "$entry")"
    mode="$(stat -Lc '%a' -- "$entry")"
    if [[ "$owner" != '0:0' ]]; then
      echo "candidate resolved entry must be root:root: $entry -> $resolved" >&2
      exit 1
    fi
    if (( (8#$mode & 8#022) != 0 )); then
      echo "candidate resolved entry must not be group/other writable: $entry -> $resolved" >&2
      exit 1
    fi
  done < <(find -P "$CANDIDATE" -type l -print0); then
    fail 65 'candidate resolved tree is broken, outside the release root, or writable'
  fi
}

assert_candidate_lock_state() {
  local candidate_real owner mode resolved target
  candidate_real="$(readlink -f -- "$CANDIDATE")"
  [[ "$candidate_real" == "$RELEASES_ROOT"/* ]] || fail 70 'candidate resolved outside releases root'
  assert_root_owned_directory "$CANDIDATE" 'candidate root'

  while IFS= read -r -d '' target; do
    owner="$(stat -c '%u:%g' -- "$target")"
    [[ "$owner" == '0:0' ]] || fail 70 "candidate symlink must be root:root: $target"
    resolved="$(readlink -f -- "$target")"
    [[ "$resolved" == "$RELEASES_ROOT"/* ]] || fail 70 "candidate symlink resolved outside releases root: $target"
    owner="$(stat -Lc '%u:%g' -- "$target")"
    mode="$(stat -Lc '%a' -- "$target")"
    [[ "$owner" == '0:0' ]] || fail 70 "candidate symlink target must be root:root: $target"
    (( (8#$mode & 8#022) == 0 )) || fail 70 "candidate symlink target must not be group/other writable: $target"
  done < <(find -P "$CANDIDATE" -xdev -type l -print0)
}

candidate_tree_hash() {
  (
    cd -- "$CANDIDATE"
    local entry relative metadata digest resolved
    while IFS= read -r -d '' entry; do
      relative="${entry#./}"
      metadata="$(stat -c '%F|%f|%u|%g|%s' -- "$entry")"
      if [[ -L "$entry" ]]; then
        digest="link:$(readlink -- "$entry")"
      elif [[ -f "$entry" ]]; then
        digest="file:$(sha256sum -- "$entry" | awk '{print $1}')"
      else
        digest='-'
      fi
      printf 'lexical\0%s\0%s\0%s\0' "$relative" "$metadata" "$digest"
    done < <(find -P . -print0 | LC_ALL=C sort -z)

    while IFS= read -r -d '' entry; do
      relative="${entry#./}"
      resolved="$(realpath -e -- "$entry")"
      metadata="$(stat -Lc '%F|%f|%u|%g|%s' -- "$entry")"
      if [[ -f "$entry" ]]; then
        digest="symlink-target-file:$(sha256sum -- "$entry" | awk '{print $1}')"
      else
        digest='-'
      fi
      printf 'resolved\0%s\0%s\0%s\0%s\0' "$relative" "$resolved" "$metadata" "$digest"
    done < <(find -P . -type l -print0 | LC_ALL=C sort -z)
  ) | sha256sum | awk '{print $1}'
}

assert_production_env_unchanged() {
  local actual_hash
  assert_root_owned_regular_file "$PRODUCTION_ENV" 'fixed production.env'
  actual_hash="$(sha256sum -- "$PRODUCTION_ENV" | awk '{print $1}')"
  if [[ "$actual_hash" != "$PRODUCTION_ENV_SHA256" ]]; then
    fail 74 'fixed production.env changed during activation'
  fi
}

read_required_production_setting() {
  local requested_key="$1"
  local line key value found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *'='* ]] || continue
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" == "$requested_key" ]] || continue
    found=$((found + 1))
    if [[ "$found" -gt 1 ]]; then
      echo "duplicate production.env key: $requested_key" >&2
      return 1
    fi
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ${#value} -ge 2 && "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ ${#value} -ge 2 && "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == "'"* || "$value" == *"'" || "$value" == '"'* || "$value" == *'"' ]]; then
      echo "invalid quoted production.env value for $requested_key" >&2
      return 1
    fi
    PRODUCTION_SETTING_VALUE="$value"
  done < "$PRODUCTION_ENV"
  if [[ "$found" -ne 1 || -z "${PRODUCTION_SETTING_VALUE:-}" ]]; then
    echo "production.env must contain exactly one non-empty $requested_key" >&2
    return 1
  fi
  printf '%s' "$PRODUCTION_SETTING_VALUE"
}

load_safe_production_settings() {
  DATABASE_PATH="$(read_required_production_setting DATABASE_PATH)" || fail 78 'invalid DATABASE_PATH in fixed production.env'
  DATA_BACKUP_DIR="$(read_required_production_setting DATA_BACKUP_DIR)" || fail 78 'invalid DATA_BACKUP_DIR in fixed production.env'
  DATA_BACKUP_RETENTION="$(read_required_production_setting DATA_BACKUP_RETENTION)" || fail 78 'invalid DATA_BACKUP_RETENTION in fixed production.env'
  DATA_BACKUP_MIN_FREE_BYTES="$(read_required_production_setting DATA_BACKUP_MIN_FREE_BYTES)" || fail 78 'invalid DATA_BACKUP_MIN_FREE_BYTES in fixed production.env'

  for configured_path in "$DATABASE_PATH" "$DATA_BACKUP_DIR"; do
    if [[ "$configured_path" != /* || "$configured_path" == *$'\n'* || "$configured_path" == *$'\r'* || "$configured_path" == *'..'* ]]; then
      fail 78 "production database and backup paths must be normalized absolute paths: $configured_path"
    fi
    if [[ "$(realpath -m -- "$configured_path")" != "$configured_path" ]]; then
      fail 78 "production database and backup paths must be normalized: $configured_path"
    fi
  done
  if [[ ! "$DATA_BACKUP_RETENTION" =~ ^[1-9][0-9]*$ ]]; then
    fail 78 'DATA_BACKUP_RETENTION must be a positive integer'
  fi
  if [[ ! "$DATA_BACKUP_MIN_FREE_BYTES" =~ ^[0-9]+$ ]]; then
    fail 78 'DATA_BACKUP_MIN_FREE_BYTES must be a non-negative integer'
  fi
  if [[ ${#DATA_BACKUP_RETENTION} -gt 16 || ( ${#DATA_BACKUP_RETENTION} -eq 16 && "$DATA_BACKUP_RETENTION" > '9007199254740991' ) ]]; then
    fail 78 'DATA_BACKUP_RETENTION exceeds the safe integer range'
  fi
  if [[ ${#DATA_BACKUP_MIN_FREE_BYTES} -gt 16 || ( ${#DATA_BACKUP_MIN_FREE_BYTES} -eq 16 && "$DATA_BACKUP_MIN_FREE_BYTES" > '9007199254740991' ) ]]; then
    fail 78 'DATA_BACKUP_MIN_FREE_BYTES exceeds the safe integer range'
  fi
  if [[ ! -f "$DATABASE_PATH" || -L "$DATABASE_PATH" ]]; then
    fail 78 "DATABASE_PATH must identify an existing regular database: $DATABASE_PATH"
  fi
}

initialize_audit() {
  if [[ -e "$AUDIT_ROOT" ]]; then
    if [[ ! -d "$AUDIT_ROOT" || -L "$AUDIT_ROOT" || "$(stat -c '%u:%g' -- "$AUDIT_ROOT")" != '0:0' ]] || find -P "$AUDIT_ROOT" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
      fail 69 "release audit root must be a root-owned non-writable directory: $AUDIT_ROOT"
    fi
  else
    install -d -o root -g root -m 0700 "$AUDIT_ROOT"
  fi
  ACTIVATION_STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  ACTIVATION_STARTED_AT="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  AUDIT_FILE="$AUDIT_ROOT/protected-release-$ACTIVATION_STAMP.audit"
  JOURNAL_FILE="$AUDIT_ROOT/protected-release-$ACTIVATION_STAMP.journal"
  : > "$AUDIT_FILE"
  : > "$JOURNAL_FILE"
  chown root:root "$AUDIT_FILE" "$JOURNAL_FILE"
  chmod 0600 "$AUDIT_FILE" "$JOURNAL_FILE"
  AUDIT_INITIALIZED=1
}

audit_event() {
  [[ "$AUDIT_INITIALIZED" -eq 1 ]] || return 0
  printf '%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$AUDIT_FILE"
}

snapshot_ai_music_processes() {
  env -i PATH="$SAFE_PATH" LC_ALL=C "$PS_BINARY" -eo user=,pid=,lstart=,args= |
    awk -v server="$AI_MUSIC_SERVER" -v worker="$AI_MUSIC_WORKER" '
      $1 == "ubuntu" {
        for (field_index = 8; field_index <= NF; field_index += 1) {
          if ($field_index == server || $field_index == worker) {
            print $0
            next
          }
        }
      }
    ' | LC_ALL=C sort
}

assert_no_active_generation_tasks() {
  local phase="$1"
  local output_file="$AUDIT_ROOT/.active-tasks-$ACTIVATION_STAMP-$phase.json"
  local status
  set +e
  env -i PATH="$SAFE_PATH" LC_ALL=C "$PYTHON_BINARY" -I -S - "$DATABASE_PATH" > "$output_file" <<'PYTHON'
import json
import os
from pathlib import Path
import sqlite3
import sys

if set(os.environ) != {"LC_ALL", "PATH"}:
    raise SystemExit("unexpected environment passed to task query")

database_uri = Path(sys.argv[1]).resolve(strict=True).as_uri() + "?mode=ro"
database = sqlite3.connect(database_uri, uri=True, timeout=5)
try:
    database.execute("PRAGMA query_only = ON")
    counts = {}
    for table in ("async_tasks", "image_generations", "video_generations"):
        present = database.execute(
            "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?",
            ("table", table),
        ).fetchone()
        if present is None:
            raise RuntimeError(f"required task table is missing: {table}")
        counts[table] = database.execute(
            f'SELECT COUNT(*) FROM "{table}" WHERE lower(status) IN (?, ?)',
            ("pending", "processing"),
        ).fetchone()[0]
    print(json.dumps(counts, separators=(",", ":"), sort_keys=True))
    if any(counts.values()):
        raise SystemExit(42)
finally:
    database.close()
PYTHON
  status=$?
  set -e
  chown root:root "$output_file"
  chmod 0600 "$output_file"
  if [[ "$status" -eq 42 ]]; then
    audit_event "active_generation_tasks phase=$phase counts=$(tr -d '\n' < "$output_file")"
    fail 76 "pending or processing generation tasks exist during $phase"
  fi
  if [[ "$status" -ne 0 ]]; then
    fail 78 "unable to query generation tasks during $phase"
  fi
  audit_event "active_generation_tasks phase=$phase counts=$(tr -d '\n' < "$output_file")"
}

create_and_verify_database_backup() {
  local create_log="$AUDIT_ROOT/.database-backup-$ACTIVATION_STAMP.create.json"
  local verify_log="$AUDIT_ROOT/.database-backup-$ACTIVATION_STAMP.verify.json"
  local backup_manifest expected_sha actual_sha status

  if [[ -e "$DATA_BACKUP_DIR" || -L "$DATA_BACKUP_DIR" ]]; then
    if [[ ! -d "$DATA_BACKUP_DIR" || -L "$DATA_BACKUP_DIR" ]]; then
      fail 78 "DATA_BACKUP_DIR must be a real directory: $DATA_BACKUP_DIR"
    fi
    if [[ "$(stat -c '%u:%g' -- "$DATA_BACKUP_DIR")" != '0:0' ]] || find -P "$DATA_BACKUP_DIR" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
      fail 78 "DATA_BACKUP_DIR must be root-owned and not group/other writable: $DATA_BACKUP_DIR"
    fi
  else
    install -d -o root -g root -m 0700 "$DATA_BACKUP_DIR"
  fi
  if [[ "$(realpath -e -- "$DATA_BACKUP_DIR")" != "$DATA_BACKUP_DIR" ]]; then
    fail 78 'DATA_BACKUP_DIR changed after production.env validation'
  fi

  DATABASE_BACKUP_PATH="$DATA_BACKUP_DIR/database-release-guard-$ACTIVATION_STAMP.sqlite"
  backup_manifest="$DATABASE_BACKUP_PATH.json"
  if [[ -e "$DATABASE_BACKUP_PATH" || -L "$DATABASE_BACKUP_PATH" || -e "$backup_manifest" || -L "$backup_manifest" ]]; then
    fail 78 'refusing to overwrite an existing release-guard database backup'
  fi

  set +e
  env -i PATH="$SAFE_PATH" LC_ALL=C "$PYTHON_BINARY" -I -S - \
    "$DATABASE_PATH" "$DATA_BACKUP_DIR" "$DATABASE_BACKUP_PATH" "$backup_manifest" \
    "$DATA_BACKUP_MIN_FREE_BYTES" "$ACTIVATION_STARTED_AT" > "$create_log" <<'PYTHON'
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys

if set(os.environ) != {"LC_ALL", "PATH"}:
    raise SystemExit("unexpected environment passed to database backup")

source_path = Path(sys.argv[1])
backup_dir = Path(sys.argv[2])
backup_path = Path(sys.argv[3])
manifest_path = Path(sys.argv[4])
minimum_free_bytes = int(sys.argv[5])
created_at = sys.argv[6]
temporary_manifest = manifest_path.with_name(manifest_path.name + f".tmp.{os.getpid()}")
source = None
destination = None

try:
    if source_path.resolve(strict=True) != source_path or not source_path.is_file() or source_path.is_symlink():
        raise RuntimeError("production database path changed or is not a regular file")
    if backup_dir.resolve(strict=True) != backup_dir or not backup_dir.is_dir() or backup_dir.is_symlink():
        raise RuntimeError("backup directory changed or is not a real directory")
    if backup_path.parent != backup_dir or manifest_path != Path(str(backup_path) + ".json"):
        raise RuntimeError("backup output path escaped the reviewed backup directory")
    required_bytes = source_path.stat().st_size + minimum_free_bytes
    if shutil.disk_usage(backup_dir).free < required_bytes:
        raise RuntimeError("insufficient free space for production database backup")

    descriptor = os.open(backup_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.close(descriptor)
    source = sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True, timeout=5)
    source.execute("PRAGMA query_only = ON")
    destination = sqlite3.connect(str(backup_path), timeout=5)
    source.backup(destination)
    destination.commit()
    quick_check = [row[0] for row in destination.execute("PRAGMA quick_check")]
    if quick_check != ["ok"]:
        raise RuntimeError(f"backup quick_check failed: {quick_check!r}")
    destination.close()
    destination = None
    source.close()
    source = None

    digest_builder = hashlib.sha256()
    with backup_path.open("rb") as backup_file:
        for chunk in iter(lambda: backup_file.read(1024 * 1024), b""):
            digest_builder.update(chunk)
    digest = digest_builder.hexdigest()
    manifest = {
        "created_at": created_at,
        "file": backup_path.name,
        "integrity": "ok",
        "quick_check": "ok",
        "sha256": digest,
        "version": "moli-drama-release-guard-backup-v1",
    }
    descriptor = os.open(temporary_manifest, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as manifest_file:
        json.dump(manifest, manifest_file, separators=(",", ":"), sort_keys=True)
        manifest_file.write("\n")
        manifest_file.flush()
        os.fsync(manifest_file.fileno())
    os.replace(temporary_manifest, manifest_path)
    os.chmod(backup_path, 0o600)
    os.chmod(manifest_path, 0o600)
    with backup_path.open("rb") as backup_file:
        os.fsync(backup_file.fileno())
    if shutil.disk_usage(backup_dir).free < minimum_free_bytes:
        raise RuntimeError("minimum free space was not preserved after backup")
    print(json.dumps({
        "created": manifest,
        "environment_keys": sorted(os.environ),
    }, separators=(",", ":"), sort_keys=True))
except BaseException:
    if destination is not None:
        destination.close()
    if source is not None:
        source.close()
    for partial in (temporary_manifest, manifest_path, backup_path):
        try:
            partial.unlink()
        except FileNotFoundError:
            pass
    raise
PYTHON
  status=$?
  set -e
  chown root:root "$create_log"
  chmod 0600 "$create_log"
  if [[ "$status" -ne 0 ]]; then
    fail 78 'production database backup creation or quick_check failed'
  fi

  assert_root_owned_regular_file "$DATABASE_BACKUP_PATH" 'production database backup'
  assert_root_owned_regular_file "$backup_manifest" 'production database backup manifest'
  set +e
  env -i PATH="$SAFE_PATH" LC_ALL=C "$PYTHON_BINARY" -I -S - \
    "$DATABASE_BACKUP_PATH" "$backup_manifest" "$DATA_BACKUP_DIR" "$DATA_BACKUP_RETENTION" > "$verify_log" <<'PYTHON'
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

if set(os.environ) != {"LC_ALL", "PATH"}:
    raise SystemExit("unexpected environment passed to database backup verification")

backup_path = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
backup_dir = Path(sys.argv[3])
retention = int(sys.argv[4])
if backup_path.resolve(strict=True) != backup_path or manifest_path.resolve(strict=True) != manifest_path:
    raise RuntimeError("database backup or manifest path changed")
if backup_path.parent != backup_dir or manifest_path != Path(str(backup_path) + ".json"):
    raise RuntimeError("database backup escaped the reviewed backup directory")
with manifest_path.open("r", encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
if set(manifest) != {"created_at", "file", "integrity", "quick_check", "sha256", "version"}:
    raise RuntimeError("database backup manifest has unexpected fields")
if manifest["version"] != "moli-drama-release-guard-backup-v1" or manifest["file"] != backup_path.name:
    raise RuntimeError("database backup manifest identity mismatch")
if manifest["integrity"] != "ok" or manifest["quick_check"] != "ok" or not re.fullmatch(r"[a-f0-9]{64}", manifest["sha256"]):
    raise RuntimeError("database backup manifest integrity fields are invalid")
digest_builder = hashlib.sha256()
with backup_path.open("rb") as backup_file:
    for chunk in iter(lambda: backup_file.read(1024 * 1024), b""):
        digest_builder.update(chunk)
digest = digest_builder.hexdigest()
if digest != manifest["sha256"]:
    raise RuntimeError("database backup hash does not match its manifest")
database = sqlite3.connect(backup_path.as_uri() + "?mode=ro", uri=True, timeout=5)
try:
    database.execute("PRAGMA query_only = ON")
    quick_check = [row[0] for row in database.execute("PRAGMA quick_check")]
finally:
    database.close()
if quick_check != ["ok"]:
    raise RuntimeError(f"database backup quick_check failed: {quick_check!r}")

pattern = re.compile(r"database-release-guard-\d{8}T\d{6}Z-\d+\.sqlite")
backups = sorted(
    (item for item in backup_dir.iterdir() if pattern.fullmatch(item.name) and item.is_file() and not item.is_symlink()),
    key=lambda item: (item.stat().st_mtime_ns, item.name),
    reverse=True,
)
for expired in backups[retention:]:
    expired_manifest = Path(str(expired) + ".json")
    expired.unlink()
    if expired_manifest.is_file() and not expired_manifest.is_symlink():
        expired_manifest.unlink()

print(f"sha256={digest}")
print("quick_check=ok")
print("environment_keys=" + ",".join(sorted(os.environ)))
PYTHON
  status=$?
  set -e
  chown root:root "$verify_log"
  chmod 0600 "$verify_log"
  if [[ "$status" -ne 0 ]]; then
    rm -f -- "$DATABASE_BACKUP_PATH" "$backup_manifest"
    fail 78 'production database backup verification failed'
  fi
  chown root:root "$DATABASE_BACKUP_PATH" "$backup_manifest"
  chmod 0600 "$DATABASE_BACKUP_PATH" "$backup_manifest"
  expected_sha="$(awk -F= '$1 == "sha256" { print $2 }' "$verify_log")"
  [[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || fail 78 'database backup verification did not return a valid SHA-256'
  actual_sha="$(sha256sum -- "$DATABASE_BACKUP_PATH" | awk '{print $1}')"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    fail 78 'database backup hash changed after verification'
  fi
  audit_event "database_backup path=$DATABASE_BACKUP_PATH sha256=$actual_sha quick_check=ok"
}

wait_for_health() {
  local healthy=0
  local attempt
  for attempt in {1..20}; do
    if env -i PATH="$SAFE_PATH" LC_ALL=C "$CURL_BINARY" --fail --silent --show-error http://127.0.0.1:5679/health >/dev/null; then
      healthy=1
      break
    fi
    env -i PATH="$SAFE_PATH" LC_ALL=C "$SLEEP_BINARY" 1
  done
  [[ "$healthy" -eq 1 ]]
}

collect_release_journal() {
  if ! env -i PATH="$SAFE_PATH" LC_ALL=C "$JOURNALCTL_BINARY" \
    -u moli-drama.service --since "$ACTIVATION_STARTED_AT" --no-pager > "$JOURNAL_FILE"; then
    return 1
  fi
  chown root:root "$JOURNAL_FILE"
  chmod 0600 "$JOURNAL_FILE"
}

atomic_set_current() {
  local release="$1"
  local temporary_link="${CURRENT_LINK}.next.$$"
  rm -f -- "$temporary_link"
  ln -s -- "$release" "$temporary_link"
  mv -Tf -- "$temporary_link" "$CURRENT_LINK"
}

AUDIT_INITIALIZED=0
SERVICE_TOUCHED=0
ACTIVATION_COMMITTED=0
AUDIT_FILE=''
JOURNAL_FILE=''
ACTIVATION_STARTED_AT=''

rollback_on_failure() {
  local status="$?"
  local rollback_status=0
  local rollback_link_ok=1
  local rollback_restart_ok=1
  trap - EXIT INT TERM
  rm -f -- "${CURRENT_LINK}.next.$$"
  if [[ "$status" -ne 0 && "$AUDIT_INITIALIZED" -eq 1 ]]; then
    audit_event "activation_failed status=$status candidate=$CANDIDATE expected=$EXPECTED_CURRENT"
  fi
  if [[ "$status" -ne 0 && "$SERVICE_TOUCHED" -eq 1 && "$ACTIVATION_COMMITTED" -ne 1 ]]; then
    set +e
    if ! atomic_set_current "$EXPECTED_CURRENT" || [[ "$(readlink -f -- "$CURRENT_LINK" 2>/dev/null)" != "$EXPECTED_CURRENT" ]]; then
      rollback_link_ok=0
    fi
    if ! env -i PATH="$SAFE_PATH" LC_ALL=C "$SYSTEMCTL_BINARY" restart moli-drama.service; then
      rollback_restart_ok=0
    fi
    if [[ "$rollback_link_ok" -ne 1 || "$rollback_restart_ok" -ne 1 ]] || ! wait_for_health; then
      rollback_status=71
      echo "release rollback health confirmation failed for $EXPECTED_CURRENT" >&2
      audit_event "rollback result=failed expected=$EXPECTED_CURRENT"
    else
      audit_event "rollback result=healthy expected=$EXPECTED_CURRENT"
    fi
    if [[ "$AUDIT_INITIALIZED" -eq 1 ]]; then
      collect_release_journal || true
    fi
    set -e
  fi
  if [[ "$rollback_status" -ne 0 ]]; then
    exit "$rollback_status"
  fi
  exit "$status"
}
trap rollback_on_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

assert_trusted_node
assert_trusted_python
assert_root_owned_directory "$(dirname -- "$CURRENT_LINK")" 'deployment root'
assert_root_owned_directory "$RELEASES_ROOT" 'releases root'
assert_root_owned_directory "$SHARED_ROOT" 'shared root'
assert_root_owned_directory "$SHARED_GUARD_ROOT" 'shared release guard root'

if [[ -L "$LOCK_FILE" ]]; then
  fail 69 "deploy lock must not be a symlink: $LOCK_FILE"
fi
exec 9>>"$LOCK_FILE"
assert_root_owned_regular_file "$LOCK_FILE" 'deploy lock'
if ! flock -n 9; then
  fail 75 'another production release is in progress'
fi

assert_current_matches
for verifier in "$SHARED_VERIFIER" "$SEQUENCE_VERIFIER" "$EXTERNAL_MODEL_VERIFIER"; do
  assert_root_owned_regular_file "$verifier" 'shared protected release verifier'
done
assert_root_owned_tree_without_symlinks "$SHARED_GUARD_ROOT" 'shared release guard'
assert_root_owned_evidence_tree
assert_candidate_tree_secure
INITIAL_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"

env -i PATH="$SAFE_PATH" LC_ALL=C "$NODE_BINARY" "$SHARED_VERIFIER" "$CANDIDATE" --require-build
env -i PATH="$SAFE_PATH" LC_ALL=C "$NODE_BINARY" "$SEQUENCE_VERIFIER" "$CANDIDATE"
env -i PATH="$SAFE_PATH" LC_ALL=C "$NODE_BINARY" "$EXTERNAL_MODEL_VERIFIER" "$CANDIDATE" "$EXTERNAL_MODEL_EVIDENCE_ROOT" "$EXPECTED_CURRENT"

assert_root_owned_evidence_tree
assert_candidate_tree_secure
POST_VERIFICATION_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"
if [[ "$POST_VERIFICATION_CANDIDATE_TREE_HASH" != "$INITIAL_CANDIDATE_TREE_HASH" ]]; then
  fail 74 'candidate tree changed during protected release verification'
fi
assert_current_matches

if [[ "$VERIFY_ONLY_REQUESTED" == '1' ]]; then
  echo "protected_release_verified=$CANDIDATE"
  exit 0
fi
if [[ "$CANDIDATE" == "$EXPECTED_CURRENT" ]]; then
  echo "protected_release_verified=$CANDIDATE"
  exit 0
fi

assert_root_owned_regular_file "$PRODUCTION_ENV" 'fixed production.env'
PRODUCTION_ENV_SHA256="$(sha256sum -- "$PRODUCTION_ENV" | awk '{print $1}')"
load_safe_production_settings
initialize_audit
audit_event "activation_start candidate=$CANDIDATE expected=$EXPECTED_CURRENT candidate_sha256=$INITIAL_CANDIDATE_TREE_HASH production_env_sha256=$PRODUCTION_ENV_SHA256"
AI_MUSIC_BEFORE="$(snapshot_ai_music_processes)"
audit_event "ai_music_before_sha256=$(printf '%s' "$AI_MUSIC_BEFORE" | sha256sum | awk '{print $1}')"

assert_production_env_unchanged
create_and_verify_database_backup
assert_no_active_generation_tasks before-stop
assert_current_matches
assert_root_owned_evidence_tree
assert_candidate_tree_secure
assert_production_env_unchanged
PRE_SWITCH_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"
if [[ "$PRE_SWITCH_CANDIDATE_TREE_HASH" != "$INITIAL_CANDIDATE_TREE_HASH" ]]; then
  fail 70 'candidate tree changed before protected release switch'
fi

SERVICE_TOUCHED=1
env -i PATH="$SAFE_PATH" LC_ALL=C "$SYSTEMCTL_BINARY" stop moli-drama.service
assert_no_active_generation_tasks after-stop

assert_current_matches
assert_root_owned_evidence_tree
assert_candidate_lock_state
assert_production_env_unchanged

atomic_set_current "$CANDIDATE"
env -i PATH="$SAFE_PATH" LC_ALL=C "$SYSTEMCTL_BINARY" restart moli-drama.service
if ! wait_for_health; then
  fail 70 'release health check failed; rollback required'
fi
if ! collect_release_journal; then
  fail 70 'unable to save release journal; rollback required'
fi
if grep -Eiq '(^|[^[:alpha:]])(fatal|unhandled rejection|uncaught exception|EADDRINUSE|Cannot find module|SyntaxError|database[^[:alnum:]]+(corrupt|malformed)|migration[^[:alnum:]]+failed)' "$JOURNAL_FILE"; then
  fail 70 'fatal startup error found in release journal; rollback required'
fi

assert_current_is_candidate
assert_root_owned_evidence_tree
assert_candidate_tree_secure
POST_HEALTH_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"
if [[ "$POST_HEALTH_CANDIDATE_TREE_HASH" != "$INITIAL_CANDIDATE_TREE_HASH" ]]; then
  fail 74 'post-health candidate tree changed; rollback required'
fi
assert_production_env_unchanged
AI_MUSIC_AFTER="$(snapshot_ai_music_processes)"
if [[ "$AI_MUSIC_AFTER" != "$AI_MUSIC_BEFORE" ]]; then
  fail 70 'AI music process snapshot changed; rollback required'
fi

audit_event "activation_success from=$EXPECTED_CURRENT to=$CANDIDATE candidate_sha256=$POST_HEALTH_CANDIDATE_TREE_HASH database_backup=$DATABASE_BACKUP_PATH"
ACTIVATION_COMMITTED=1
SERVICE_TOUCHED=0

echo "protected_release_audit=$AUDIT_FILE"
echo "protected_release_journal=$JOURNAL_FILE"
echo "protected_release_database_backup=$DATABASE_BACKUP_PATH"
echo "protected_release_switched_from=$EXPECTED_CURRENT"
echo "protected_release_switched_to=$CANDIDATE"
