#!/usr/bin/env bash
# 正式轮换共享门禁中的 reviewed source SHA 组。
# 用法: rotate-reviewed-source-group.sh GROUP_NAME FILE_REL_PATH CANDIDATE_RELEASE
# 仅打印应写入 verifier 的 LF-normalized SHA256，并提示走独立门禁升级流程；
# 绝不直接覆盖 /opt/moli-drama/shared/release-guard。
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "usage: $0 GROUP_NAME FILE_REL_PATH CANDIDATE_RELEASE" >&2
  exit 64
fi

GROUP_NAME="$1"
FILE_REL="$2"
CANDIDATE="$3"
TARGET="$CANDIDATE/$FILE_REL"

if [[ ! -f "$TARGET" ]]; then
  echo "missing file: $TARGET" >&2
  exit 66
fi

HASH="$(TARGET_FILE="$TARGET" python3 - <<'PY'
import hashlib, os, pathlib
raw = pathlib.Path(os.environ['TARGET_FILE']).read_bytes().replace(b'\r\n', b'\n').replace(b'\r', b'\n')
print(hashlib.sha256(raw).hexdigest())
PY
)"

cat <<EOF
reviewed_source_group=$GROUP_NAME
file=$FILE_REL
sha256=$HASH
next_steps:
  1. 在候选 verifier 中新增/更新 ${GROUP_NAME}，写入上述 sha256
  2. 将该组前置到相关 imageVip/KM reviewed 组
  3. 作为独立安全变更安装共享 verifier（禁止业务候选直接覆盖）
  4. 再从实时 current 克隆业务候选并只覆盖 ${FILE_REL}
EOF
