# 共享受保护发布低停机实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 保留四次完整候选树哈希和全部安全门禁，同时把完整哈希移出 `systemctl stop` 到新版本 `restart` 的停机区间，并记录可审计的单调时钟阶段耗时。

**架构：** 共享激活器先在线完成备份、静默检查和切换前完整哈希，停服后只执行活动任务、CAS、证据/候选锁定状态和环境哈希等快速检查，再立即切换并重启。安全变更只修改激活器、轮换脚本和 Linux fixture 测试，独立于画布业务 PR；轮换与生产激活仍需后续分别授权。

**技术栈：** Bash 5、Linux `/proc/uptime`、systemd、SQLite、Node.js `node:test`、WSL/root Linux fixture、SHA-256 CAS

---

## 文件结构与职责

- 修改 `deploy/release-guard/activate-protected-release.sh`：重排切换前哈希，增加快速锁定检查和单调时钟阶段审计。
- 修改 `backend-node/test/sharedReleaseGuardRotation.test.js`：锁定顺序、失败回滚、哈希延迟隔离、审计字段和 AI 音乐隔离。
- 修改 `deploy/rotate-external-model-release-guard.sh`：在最终脚本冻结后更新已审查旧/新激活器 SHA-256。
- 不修改任何业务 release、前端、后端 API、数据库迁移、模型、积分或 AI 音乐文件。

## 固定安全合同

完整哈希保持四次且全部与 `INITIAL_CANDIDATE_TREE_HASH` 比较：初始、验证后、切换前、健康后。停机窗口严格定义为调用 `systemctl stop moli-drama.service` 前记录起点，到候选的 `systemctl restart moli-drama.service` 返回后记录终点；该窗口内不得出现 `candidate_tree_hash`、构建、依赖安装、迁移、供应商请求或浏览器操作。

阶段审计键固定为：

```text
preflight_verification_ms
database_backup_ms
pre_switch_hash_ms
service_stop_ms
post_stop_checks_ms
service_restart_ms
health_wait_ms
post_health_hash_ms
downtime_window_ms
```

### 任务 1：冻结顺序与审计静态合同

**文件：**
- 修改：`backend-node/test/sharedReleaseGuardRotation.test.js:511-569`
- 测试：`backend-node/test/sharedReleaseGuardRotation.test.js`

- [ ] **步骤 1：编写停机窗口顺序红测**

在现有 activator 源码合同测试后加入：

```js
test('full candidate hashes remain four while the downtime window contains only fast checks', () => {
  const source = fs.readFileSync(activatorPath, 'utf8')
  const initialHash = source.indexOf('INITIAL_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"')
  const postVerificationHash = source.indexOf('POST_VERIFICATION_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"')
  const preSwitchHash = source.indexOf('PRE_SWITCH_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"')
  const stop = source.indexOf('"$SYSTEMCTL_BINARY" stop moli-drama.service')
  const restart = source.indexOf('"$SYSTEMCTL_BINARY" restart moli-drama.service', stop)
  const postHealthHash = source.indexOf('POST_HEALTH_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"')

  assert.ok(initialHash < postVerificationHash)
  assert.ok(postVerificationHash < preSwitchHash)
  assert.ok(preSwitchHash < stop)
  assert.ok(stop < restart)
  assert.ok(restart < postHealthHash)

  const downtimeSource = source.slice(stop, restart)
  assert.doesNotMatch(downtimeSource, /candidate_tree_hash|find\s+[^\n]*-type\s+f|sha256sum\s+[^\n]*candidate/i)
  assert.match(downtimeSource, /assert_no_active_generation_tasks/)
  assert.match(downtimeSource, /assert_current_matches/)
  assert.match(downtimeSource, /assert_root_owned_evidence_tree/)
  assert.match(downtimeSource, /assert_candidate_lock_state/)
  assert.match(downtimeSource, /assert_production_env_unchanged/)
})
```

- [ ] **步骤 2：编写阶段审计与敏感信息红测**

加入：

```js
test('activation audit records monotonic phase timings without environment values', () => {
  const source = fs.readFileSync(activatorPath, 'utf8')
  assert.match(source, /monotonic_ms\(\)/)
  assert.match(source, /\/proc\/uptime/)
  for (const field of [
    'preflight_verification_ms', 'database_backup_ms', 'pre_switch_hash_ms',
    'service_stop_ms', 'post_stop_checks_ms', 'service_restart_ms',
    'health_wait_ms', 'post_health_hash_ms', 'downtime_window_ms',
  ]) assert.match(source, new RegExp(`audit_phase_timing ${field} `))
  assert.doesNotMatch(source, /audit_event[^\n]*(?:PROVIDER_SECRET|DATABASE_URL|API_KEY|TOKEN)=/)
})
```

- [ ] **步骤 3：运行静态测试确认红灯**

```powershell
cd backend-node
node --test --test-name-pattern="full candidate hashes|activation audit" test/sharedReleaseGuardRotation.test.js
```

预期：FAIL；切换前哈希当前位于 stop 后，且尚无固定阶段耗时键。

- [ ] **步骤 4：Commit 红测**

```powershell
git add backend-node/test/sharedReleaseGuardRotation.test.js
git commit -m "test(门禁): 冻结低停机顺序与耗时合同"
```

### 任务 2：实现快速锁定检查与停服前完整哈希

**文件：**
- 修改：`deploy/release-guard/activate-protected-release.sh:173-249,724-790`
- 测试：`backend-node/test/sharedReleaseGuardRotation.test.js`

- [ ] **步骤 1：拆出不读取普通文件内容的快速锁定函数**

在 `assert_candidate_tree_secure` 后加入职责明确的函数：

```bash
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
```

该函数允许读取目录项、owner/mode 和符号链接目标，但不得读取普通文件内容、不得调用 `candidate_tree_hash`。保留原 `assert_candidate_tree_secure` 供在线完整预检和健康后检查。

- [ ] **步骤 2：把切换前完整哈希移动到 stop 前最后位置**

在数据库备份、在线活动任务、current CAS、证据树、候选安全和环境检查全部通过后执行：

```bash
assert_root_owned_evidence_tree
assert_candidate_tree_secure
assert_production_env_unchanged
PRE_SWITCH_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"
[[ "$PRE_SWITCH_CANDIDATE_TREE_HASH" == "$INITIAL_CANDIDATE_TREE_HASH" ]] || \
  fail 70 'candidate tree changed before protected release switch'
```

紧接着进入：

```bash
SERVICE_TOUCHED=1
env -i PATH="$SAFE_PATH" LC_ALL=C "$SYSTEMCTL_BINARY" stop moli-drama.service
assert_no_active_generation_tasks 'after-stop'
assert_current_matches
assert_root_owned_evidence_tree
assert_candidate_lock_state
assert_production_env_unchanged
atomic_set_current "$CANDIDATE"
env -i PATH="$SAFE_PATH" LC_ALL=C "$SYSTEMCTL_BINARY" restart moli-drama.service
```

删除 stop 后原有的 `PRE_SWITCH_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"`，不得删除初始、验证后或健康后哈希。

- [ ] **步骤 3：运行顺序静态测试确认绿灯**

```powershell
cd backend-node
node --test --test-name-pattern="full candidate hashes" test/sharedReleaseGuardRotation.test.js
```

预期：PASS；源码仍有四次完整哈希，stop/restart 片段没有完整内容扫描。

- [ ] **步骤 4：运行 Shell 语法检查**

```powershell
wsl.exe -- bash -n /mnt/c/Users/canqu/Documents/茉莉妈妈2/worktrees/canvas-release-resilience-spec-20260824/deploy/release-guard/activate-protected-release.sh
```

预期：exit code 0，无输出。

- [ ] **步骤 5：Commit 顺序实现**

```powershell
git add deploy/release-guard/activate-protected-release.sh
git commit -m "fix(门禁): 将完整哈希移出停机窗口"
```

### 任务 3：增加单调时钟阶段耗时审计

**文件：**
- 修改：`deploy/release-guard/activate-protected-release.sh:328-350,656-800`
- 测试：`backend-node/test/sharedReleaseGuardRotation.test.js`

- [ ] **步骤 1：增加单调时钟和安全耗时写入函数**

在审计函数附近加入：

```bash
monotonic_ms() {
  awk '{ printf "%.0f\n", $1 * 1000 }' /proc/uptime
}

elapsed_ms() {
  local started_ms="$1"
  local finished_ms
  finished_ms="$(monotonic_ms)"
  printf '%s\n' "$((finished_ms - started_ms))"
}

audit_phase_timing() {
  local key="$1"
  local value="$2"
  [[ "$key" =~ ^[a-z_]+_ms$ && "$value" =~ ^[0-9]+$ ]] || fail 70 'invalid phase timing audit value'
  audit_event "phase_timing $key=$value"
}
```

只写固定键和十进制毫秒，不把环境变量值、命令行、数据库内容或用户数据传给 `audit_phase_timing`。

- [ ] **步骤 2：为在线阶段记录耗时并在审计初始化后补写**

在验证开始前记录 `preflight_started_ms`，在验证后哈希比较完成后保存：

```bash
PREFLIGHT_VERIFICATION_MS="$(elapsed_ms "$preflight_started_ms")"
```

`initialize_audit` 后立即写入：

```bash
audit_phase_timing preflight_verification_ms "$PREFLIGHT_VERIFICATION_MS"
```

分别围绕数据库备份与切换前哈希记录：

```bash
phase_started_ms="$(monotonic_ms)"
create_and_verify_database_backup
audit_phase_timing database_backup_ms "$(elapsed_ms "$phase_started_ms")"

phase_started_ms="$(monotonic_ms)"
PRE_SWITCH_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"
audit_phase_timing pre_switch_hash_ms "$(elapsed_ms "$phase_started_ms")"
```

- [ ] **步骤 3：为停机、重启、健康和健康后哈希记录耗时**

停机窗口使用独立起点：

```bash
downtime_started_ms="$(monotonic_ms)"
phase_started_ms="$downtime_started_ms"
SERVICE_TOUCHED=1
env -i PATH="$SAFE_PATH" LC_ALL=C "$SYSTEMCTL_BINARY" stop moli-drama.service
audit_phase_timing service_stop_ms "$(elapsed_ms "$phase_started_ms")"

phase_started_ms="$(monotonic_ms)"
assert_no_active_generation_tasks 'after-stop'
assert_current_matches
assert_root_owned_evidence_tree
assert_candidate_lock_state
assert_production_env_unchanged
audit_phase_timing post_stop_checks_ms "$(elapsed_ms "$phase_started_ms")"

atomic_set_current "$CANDIDATE"
phase_started_ms="$(monotonic_ms)"
env -i PATH="$SAFE_PATH" LC_ALL=C "$SYSTEMCTL_BINARY" restart moli-drama.service
audit_phase_timing service_restart_ms "$(elapsed_ms "$phase_started_ms")"
audit_phase_timing downtime_window_ms "$(elapsed_ms "$downtime_started_ms")"
```

健康等待和健康后哈希分别使用 `health_wait_ms`、`post_health_hash_ms`。所有已完成字段在后续失败时已经落盘，`rollback_on_failure` 继续追加失败和回滚结果，不覆盖审计文件。

- [ ] **步骤 4：运行审计静态测试确认绿灯**

```powershell
cd backend-node
node --test --test-name-pattern="activation audit" test/sharedReleaseGuardRotation.test.js
```

预期：PASS；九个固定键均出现，未匹配敏感值写入。

- [ ] **步骤 5：Commit 耗时审计**

```powershell
git add deploy/release-guard/activate-protected-release.sh
git commit -m "feat(门禁): 记录单调时钟阶段耗时"
```

### 任务 4：用 Linux fixture 证明哈希延迟不进入停机窗口

**文件：**
- 修改：`backend-node/test/sharedReleaseGuardRotation.test.js:346-490,780-890`
- 测试：`backend-node/test/sharedReleaseGuardRotation.test.js`

- [ ] **步骤 1：让 fixture 能注入完整哈希延迟并记录 systemctl 单调时间**

扩展 `materializeActivator` 的第二参数，只在复制到 `/tmp` 的测试脚本中将 `candidate_tree_hash() {` 替换为：

```js
const materializeActivator = (commandOverrides = {}, { candidateTreeHashPrologue = '' } = {}) => {
  const replacements = {
    '/usr/bin/node': trustedNode,
    '/opt/moli-drama/releases': releasesRoot,
    '/opt/moli-drama/current': currentLink,
    '/opt/moli-drama/shared': sharedRoot,
    ...commandOverrides,
  }
  let activatorSource = fs.readFileSync(activatorPath, 'utf8')
  for (const [productionPath, testPath] of Object.entries(replacements)) {
    activatorSource = activatorSource.replaceAll(productionPath, testPath)
  }
  if (candidateTreeHashPrologue) {
    activatorSource = activatorSource.replace(
      'candidate_tree_hash() {',
      `candidate_tree_hash() {\n  ${candidateTreeHashPrologue}`,
    )
  }
  writeLinuxFile(testActivator, activatorSource, '0555')
}
```

`configureActualActivation` 中使用现有 replacements 变量调用：

```js
fixture.materializeActivator({
  '/usr/bin/systemctl': systemctl,
  '/usr/bin/curl': curl,
  '/usr/bin/journalctl': journalctl,
  '/usr/bin/ps': ps,
  '/usr/bin/sleep': sleep,
}, {
  candidateTreeHashPrologue: options.hashDelayMs
    ? `/usr/bin/python3 -c 'import time; time.sleep(${Number(options.hashDelayMs) / 1000})'`
    : '',
})
```

生成的测试脚本在 `hashDelayMs: 1000` 时等价包含：

```bash
candidate_tree_hash() {
  /usr/bin/python3 -c 'import time; time.sleep(1.0)'
```

生产脚本不得加入测试环境变量或测试睡眠。systemctl 替身改为记录：

```js
writeLinuxFile(systemctl, `#!/bin/sh
set -eu
timestamp="$(/usr/bin/awk '{ printf "%.0f", $1 * 1000 }' /proc/uptime)"
printf '%s %s\\n' "$timestamp" "$*" >> ${shellQuote(serviceLog)}
`, '0555')
```

- [ ] **步骤 2：编写三次性能 fixture 测试**

加入：

```js
test('three activations exclude full-hash delay from stop-to-restart downtime', { skip: !rootBashAvailable }, (t) => {
  for (let run = 0; run < 3; run += 1) {
    const fixture = makeActivatorFixture(t)
    const operations = configureActualActivation(fixture, { hashDelayMs: 1000 })
    const result = runActivator(fixture)
    assert.equal(result.status, 0, result.stderr)

    const operationsLog = readLinuxFile(operations.serviceLog).toString('utf8').trim().split('\n')
    const stop = operationsLog.find((line) => line.endsWith(' stop moli-drama.service'))
    const restart = operationsLog.find((line) => line.endsWith(' restart moli-drama.service'))
    assert.ok(stop && restart)
    assert.ok(Number(restart.split(' ')[0]) - Number(stop.split(' ')[0]) < 900)

    const audit = readLinuxFile(result.stdout.match(/protected_release_audit=(.+)/)[1]).toString('utf8')
    for (const field of [
      'preflight_verification_ms', 'database_backup_ms', 'pre_switch_hash_ms',
      'service_stop_ms', 'post_stop_checks_ms', 'service_restart_ms',
      'health_wait_ms', 'post_health_hash_ms', 'downtime_window_ms',
    ]) assert.match(audit, new RegExp(`phase_timing ${field}=\\d+`))
  }
})
```

阈值 `900ms` 小于每次完整哈希注入的 `1000ms`，用来证明至少一次完整哈希没有落入 stop/restart；三次全部必须通过，不取最快值。

- [ ] **步骤 3：扩展停服后失败回滚断言**

在已有 post-stop pending、current drift、环境/权限变化测试中统一增加：

```js
assert.notEqual(result.status, 0)
const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true })
assert.equal(current.status, 0, current.stderr)
assert.equal(current.stdout.trim(), fixture.expected)
assert.match(readLinuxFile(operations.serviceLog).toString('utf8'), /restart moli-drama\.service/)
assert.doesNotMatch(readLinuxFile(operations.serviceLog).toString('utf8'), /moli-mama/)
```

测试必须验证旧 current 健康恢复，而不只是非零退出。

- [ ] **步骤 4：运行 fixture 测试**

```powershell
cd backend-node
node --test --test-concurrency=1 --test-name-pattern="three activations|post-stop|current drift|health failure|post-health|AI music" test/sharedReleaseGuardRotation.test.js
```

预期：全部 PASS；如环境无 root Bash 只能显示 `SKIP`，该 SKIP 不能作为验收完成证据，必须在具备 root Bash 的 WSL/Linux 重跑。

- [ ] **步骤 5：Commit Linux 证据**

```powershell
git add backend-node/test/sharedReleaseGuardRotation.test.js
git commit -m "test(门禁): 证明完整哈希不占停机窗口"
```

### 任务 5：冻结激活器哈希并验证原子轮换

**文件：**
- 修改：`deploy/rotate-external-model-release-guard.sh:11-16`
- 测试：`backend-node/test/sharedReleaseGuardRotation.test.js:893-1095`

- [ ] **步骤 1：计算冻结后的激活器 SHA-256**

```powershell
$newHash = (Get-FileHash -Algorithm SHA256 deploy/release-guard/activate-protected-release.sh).Hash.ToLowerInvariant()
$newHash
```

预期：输出一个 64 位小写十六进制值。记录当前生产已审查版本：

```text
c1d987123f6655a07351f7c4891fd3d0229c3cb64776e635c3f339c986d15eb0
```

- [ ] **步骤 2：先更新测试期望并确认红灯**

在 rotation 静态测试中断言：

```js
const activatorHash = sha256(fs.readFileSync(activatorPath))
assert.match(rotationSource, /EXPECTED_INSTALLED_ACTIVATOR_SHA256='c1d987123f6655a07351f7c4891fd3d0229c3cb64776e635c3f339c986d15eb0'/)
assert.match(rotationSource, new RegExp(`EXPECTED_NEW_ACTIVATOR_SHA256='${activatorHash}'`))
```

运行：

```powershell
cd backend-node
node --test --test-name-pattern="manual rotation hard-codes" test/sharedReleaseGuardRotation.test.js
```

预期：FAIL，轮换脚本尚未登记新旧哈希。

- [ ] **步骤 3：精准更新轮换 CAS 常量**

用步骤 1 的 `$newHash` 精准替换当前常量：

```powershell
$rotationPath = 'deploy/rotate-external-model-release-guard.sh'
$rotation = Get-Content -Raw -Encoding UTF8 $rotationPath
$rotation = $rotation -replace "EXPECTED_INSTALLED_ACTIVATOR_SHA256='[a-f0-9]{64}'", "EXPECTED_INSTALLED_ACTIVATOR_SHA256='c1d987123f6655a07351f7c4891fd3d0229c3cb64776e635c3f339c986d15eb0'"
$rotation = $rotation -replace "EXPECTED_NEW_ACTIVATOR_SHA256='[a-f0-9]{64}'", "EXPECTED_NEW_ACTIVATOR_SHA256='$newHash'"
[System.IO.File]::WriteAllText((Resolve-Path $rotationPath), $rotation, [System.Text.UTF8Encoding]::new($false))
```

如果激活器在此后发生任何字节变化，重新执行步骤 1 和本步骤。`EXPECTED_OLD_ACTIVATOR_SHA256` 保留历史兼容值，不扩大其他脚本哈希白名单。

- [ ] **步骤 4：运行轮换 CAS、原子替换和回滚测试**

```powershell
cd backend-node
node --test --test-concurrency=1 --test-name-pattern="manual rotation" test/sharedReleaseGuardRotation.test.js
```

预期：全部 PASS；未知旧哈希被拒绝，已审查旧哈希可轮换，新哈希精确匹配，部分安装会恢复旧门禁且不遗留 staging。

- [ ] **步骤 5：再次冻结哈希并检查脚本语法**

```powershell
$actual = (Get-FileHash -Algorithm SHA256 deploy/release-guard/activate-protected-release.sh).Hash.ToLowerInvariant()
Select-String -Path deploy/rotate-external-model-release-guard.sh -Pattern $actual
wsl.exe -- bash -n /mnt/c/Users/canqu/Documents/茉莉妈妈2/worktrees/canvas-release-resilience-spec-20260824/deploy/release-guard/activate-protected-release.sh
wsl.exe -- bash -n /mnt/c/Users/canqu/Documents/茉莉妈妈2/worktrees/canvas-release-resilience-spec-20260824/deploy/rotate-external-model-release-guard.sh
```

预期：`Select-String` 命中 `EXPECTED_NEW_ACTIVATOR_SHA256`；两次 `bash -n` exit code 0。

- [ ] **步骤 6：Commit 轮换哈希**

```powershell
git add deploy/rotate-external-model-release-guard.sh backend-node/test/sharedReleaseGuardRotation.test.js
git commit -m "security(门禁): 冻结低停机激活器轮换哈希"
```

### 任务 6：完整安全回归与独立 PR 准备

**文件：**
- 不新增实现文件
- 审核：`deploy/release-guard/activate-protected-release.sh`
- 审核：`deploy/rotate-external-model-release-guard.sh`
- 审核：`backend-node/test/sharedReleaseGuardRotation.test.js`

- [ ] **步骤 1：运行完整共享门禁测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/sharedReleaseGuardRotation.test.js
```

预期：原有 37 项与新增测试全部 PASS；root fixture 不得 SKIP。若 Windows 当前没有可用 root WSL，复制分支到受控 Linux CI 重跑，取得完整 PASS 才能提交安全 PR 审查。

- [ ] **步骤 2：核对四次哈希与停机区间**

```powershell
$source = Get-Content -Raw deploy/release-guard/activate-protected-release.sh
([regex]::Matches($source, 'candidate_tree_hash')).Count
$start = $source.IndexOf('"$SYSTEMCTL_BINARY" stop moli-drama.service')
$end = $source.IndexOf('"$SYSTEMCTL_BINARY" restart moli-drama.service', $start)
$source.Substring($start, $end - $start) | Select-String -Pattern 'candidate_tree_hash|sha256sum.*CANDIDATE'
```

预期：函数定义加四次调用满足测试固定计数；停机片段搜索无命中。

- [ ] **步骤 3：审计精准范围和敏感信息**

```powershell
git diff origin/main --name-only
git diff --check origin/main
rg -n "phase_timing|PROVIDER_SECRET|API_KEY|TOKEN|DATABASE_URL" deploy/release-guard/activate-protected-release.sh
git diff origin/main -- frontweb backend-node/src
```

预期：实现 diff 仅含 3 个安全文件及本计划/规格文档；`git diff --check` 无输出；审计语句没有输出敏感值；业务源码 diff 为空。

- [ ] **步骤 4：确认 AI 音乐和生产动作不存在**

```powershell
rg -n "systemctl.*moli-mama|restart.*moli-mama|stop.*moli-mama" deploy/release-guard/activate-protected-release.sh deploy/rotate-external-model-release-guard.sh
git status --short --branch
```

预期：第一条无命中；分支只含计划内提交，没有生产候选、数据库备份文件或密钥。

- [ ] **步骤 5：提交验收记录**

在计划末尾追加实际测试总数、三次性能 fixture 数据、最终激活器哈希、`bash -n` 结果与“未轮换/未部署”声明，然后提交：

```powershell
git add docs/superpowers/plans/2026-08-24-protected-release-downtime.md
git commit -m "docs(门禁): 记录低停机安全验收"
```

预期：本地安全分支 clean，尚未 push、未轮换共享门禁、未停服、未激活候选。

## 规格覆盖检查

| 规格要求 | 实现任务 |
| --- | --- |
| 初始、验证后、切换前、健康后四次完整哈希 | 任务 1、2、6 |
| 切换前哈希在 stop 前，停机窗口无全树扫描 | 任务 1、2、4 |
| 停机窗口保留任务/CAS/证据/权限/环境快检 | 任务 1、2、4 |
| verify-only 不备份、不停服、不切换 | 既有基线，任务 6 全量回归 |
| 九项单调时钟耗时及失败审计保留 | 任务 1、3、4 |
| 备份、健康、日志、回滚合同不弱化 | 任务 4、6 |
| AI 音乐只快照、不操作，漂移回滚 | 任务 4、6 |
| 三次近生产规模性能 fixture | 任务 4 |
| 已安装旧哈希与新哈希精确 CAS 轮换 | 任务 5 |
| 安全 PR、轮换、业务激活分别授权 | 任务 6、执行边界 |

## 执行边界

完成任务 1-6 只表示独立安全分支可申请 PR 审查。即使 PR 合入，也不得自动轮换 `/opt/moli-drama/shared/release-guard`；轮换前必须重新读取实时安装哈希、协调部署锁、备份共享门禁和生产 SQLite，并取得单独明确授权。轮换完成后的 verify-only 与业务候选激活仍是两个独立授权步骤。
