#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  echo "usage: $0 SOURCE_RELEASE [SHARED_GUARD_DIRECTORY]" >&2
  exit 64
fi

if [[ ! -d "$1" ]]; then
  echo "source release must exist" >&2
  exit 66
fi
SOURCE_RELEASE="$(realpath -- "$1")"
TARGET_DIRECTORY="${2:-/opt/moli-drama/shared/release-guard}"
VERIFIER_SOURCE="$SOURCE_RELEASE/backend-node/src/services/canvasCreditReleaseContract.js"
ACTIVATOR_SOURCE="$SOURCE_RELEASE/deploy/activate-protected-release.sh"
SHARED_VERIFIER="$TARGET_DIRECTORY/verify-protected-release.js"
SHARED_ACTIVATOR="$TARGET_DIRECTORY/activate-protected-release.sh"

if [[ ! -f "$VERIFIER_SOURCE" || ! -f "$ACTIVATOR_SOURCE" ]]; then
  echo "source release does not contain the protected release guard" >&2
  exit 66
fi

install -d -m 0755 "$TARGET_DIRECTORY"

if [[ -e "$SHARED_VERIFIER" || -e "$SHARED_ACTIVATOR" ]]; then
  if [[ ! -f "$SHARED_VERIFIER" || ! -f "$SHARED_ACTIVATOR" ]]; then
    echo "shared release guard is incomplete; refusing automatic repair" >&2
    exit 69
  fi
  node "$SHARED_VERIFIER" "$SOURCE_RELEASE" --require-build
  if ! cmp -s "$VERIFIER_SOURCE" "$SHARED_VERIFIER" || ! cmp -s "$ACTIVATOR_SOURCE" "$SHARED_ACTIVATOR"; then
    echo "candidate releases cannot replace the installed shared guard; use an explicitly reviewed manual rotation" >&2
    exit 73
  fi
  echo "protected_release_guard_already_installed=$TARGET_DIRECTORY"
  exit 0
fi

if [[ "${PROTECTED_RELEASE_GUARD_BOOTSTRAP:-0}" != "1" ]]; then
  echo "first installation requires PROTECTED_RELEASE_GUARD_BOOTSTRAP=1 after explicit review" >&2
  exit 77
fi

install -m 0555 "$VERIFIER_SOURCE" "$SHARED_VERIFIER.next"
install -m 0555 "$ACTIVATOR_SOURCE" "$SHARED_ACTIVATOR.next"

if ! node "$SHARED_VERIFIER.next" "$SOURCE_RELEASE" --require-build; then
  rm -f "$SHARED_VERIFIER.next" "$SHARED_ACTIVATOR.next"
  echo "source release failed the protected UI contract; shared guard was not updated" >&2
  exit 1
fi

mv "$SHARED_VERIFIER.next" "$SHARED_VERIFIER"
mv "$SHARED_ACTIVATOR.next" "$SHARED_ACTIVATOR"
echo "protected_release_guard_installed=$TARGET_DIRECTORY"
