# 一键转绘 owner-scoped 补充对白审批本地证据

日期：2026-08-28

范围：仅本地实现、测试与审查；未调用真实供应商、未付费、未 push、未部署、未写生产数据库或 shared 状态。

## 结论

补充对白审批合同的本地实现已完成。Rafael 第 6 镜的 `Welcome home, son.` 只作为 `source_translation=false` 的 owner HTTP 审批输入存在；source 与 localized dialogue 中 Rafael turn 均保持为 0。五个角色的 production voice 登记、审核、绑定、角色复审与 character-plan 通过真实本地 router、认证和 tenant header 链路完成。

本结论不等于九镜完整媒体链已验收。15 项批准本地媒体尚未齐全，因此对应 Playwright 用例保持显式 skipped，launcher 返回 `required_local_media_missing` 和退出码 2。

## 变更与提交

| 提交 | 内容 |
| --- | --- |
| `7bcce8bf` | 设计与实施计划 |
| `9585f5a4` | migration 与 owner-scoped 审批服务 |
| `84ed5a50` | 受保护创建/撤销 HTTP 路由 |
| `fc90716c` | registration 合并审批证据与撤销复核 |
| `d213555f` | production voice 严格信任重验证 |
| `68841fc9` | Task 8 真实 HTTP 五角色本地验收链 |
| `533f2153` | 阻止补充对白输入反向污染权威 source facts |

所有提交均为本地提交；本阶段未 push。

## 合同证据

- 创建审批使用真实 router、认证和 `X-Tenant-Id`，响应固定为 12 个脱敏字段，不返回正文。
- registration 请求仍只接受 `idempotency_key` 与 `expected_updated_at`，不接收台词。
- Rafael fixture 只保留 `shot_id`、`source_character_key`、`target_text`、`source_translation:false`，不再伪装为持久化证据。
- Rafael 登记证据引用服务端生成的 approval ID、target text SHA 与 approval evidence SHA；外部证据不含正文。
- 链后只读 SQL 审计得到 1 条 active supplemental approval、5 条 local voice registration；未使用 SQL 写入或 DB proxy 完成业务状态。
- 审批撤销、上下文漂移、facts/policy/localization/CAS 漂移均 fail closed；历史音频与登记保留审计，但不能继续获得新的 production voice 信任。
- source/localized dialogue 未增加 Rafael turn，V2 1:1 与 silent-shot 合同未放宽。
- 网络守卫覆盖 Node `http`、`https`、`undici` 入口；危险本地路由和未知 clean-provider shot ID 均 fail closed。

## Fresh 本地回归

### 后端

命令：

```text
node --test --test-concurrency=1 test/redrawMigration.test.js test/redrawSupplementalDialogueApproval.test.js test/redrawSupplementalDialogueRoutes.test.js test/redrawLocalVoiceRegistration.test.js test/redrawLocalVoiceRoutes.test.js test/redrawVoices.test.js test/redrawVoices.routes.test.js test/redrawVoiceAssetIntegration.test.js test/redrawCharacterPlan.test.js test/redrawReviewGate.test.js
```

结果：235 tests，235 pass，0 fail，0 skipped。

### Task 8 Playwright

命令：

```text
npx playwright test e2e/redraw-live-launcher.spec.js --workers=1
```

结果：11 tests，10 pass，0 fail，1 skipped。

通过项包含 fixture 边界、权威 source facts 反向门禁、媒体预检、网络副作用门禁、五角色 HTTP 链、clean-provider shot fail-closed 与脱敏汇总。唯一 skipped 项是 15 项批准本地媒体齐备后的完整九镜运行链。

## RED -> GREEN 与独立审查

- Task 1：migration/service 首轮 RED；修复后目标回归 49/49，并通过独立规格与质量审查。
- Task 2：HTTP 路由首轮 8/8 RED；修复后相关回归 158/158，并通过独立规格与质量审查。
- Task 3：registration 首轮 5 个预期失败；补充 legacy 无补句兼容边界后组合回归 97/97，并通过独立规格与质量审查。
- Task 4：production voice 首轮 3 个预期失败；补齐严格白名单与活动审批复核后通过目标、依赖及独立审查。
- Task 5：主链首轮 2 fail / 6 pass / 1 skip；GREEN 后独立质量审查又发现请求路径守卫绕过和未知 shot 静默回落，新增 2 个 RED 后 fail-closed 修复；第一轮最终 9 pass / 1 skip，规格审查 PASS，质量复审 APPROVE。
- 最终审查修复：总审查发现补充对白输入会反向把 Rafael 注入权威 `visible_character_ids`。新增反向测试先复现失败；移除注入后，权威 source facts 隐藏 Rafael 时，真实 HTTP 审批返回 422，approval、registration 与 registration attempts 均为 0；最终 Playwright 10 pass / 1 skip，规格复审 PASS，质量复审 APPROVE（0 findings）。

以上 RED 数量与各阶段 reviewer verdict 是本会话保存的执行记录，不是可重新生成的失败日志。可独立重跑的当前证据是本报告“Fresh 本地回归”中的 235/235 后端结果与 10/1 Playwright 结果；历史 RED 用于证明 TDD 顺序，不应被解释为当前 checkout 可复现的失败。

## 独立最终审查记录

### 规格符合性审查

- 初审结论：代码与 fresh tests 对本地合同无阻塞违规；因报告尚未持久化详细 RED/review 记录，证据等级给出 PARTIAL。
- 初审确认：15 项媒体缺失被正确标为未完成，不影响本地补充对白合同代码结论，也不得升级为整集媒体验收。
- 处置：在本报告补充每阶段执行记录、审查结论及证据等级说明，并保留 fresh 可重跑命令。

### 代码质量与安全审查

- 初审结论：REQUEST CHANGES，唯一 MEDIUM finding 为补充对白 fixture 自证 Rafael 在第 6 镜可见。
- 修复：提交 `533f2153` 移除补充输入对 `character_ids/visible_character_ids` 的注入；默认 Rafael 可见性来自独立权威 source facts map。
- 反向证据：权威 source facts 移除 Rafael 后，真实 router/auth/tenant HTTP 审批返回 `REDRAW_SUPPLEMENTAL_DIALOGUE_NOT_READY`，不产生审批、登记、供应商或计费副作用。
- 复审结论：规格 PASS；代码质量 APPROVE，0 findings。

## 零副作用审计

| 项目 | 结果 |
| --- | --- |
| 外部供应商 HTTP/生成调用 | 0 |
| provider/voice provider 调用 | 0 |
| 生成提交 | 0 |
| 付费、积分冻结或扣除 | 0 |
| 生产数据库/shared/current/candidate 写入 | 0 |
| push/部署/activate | 0 |

## 明确未通过的交付门禁

- 15 项批准本地媒体缺失，九镜完整本地媒体运行链未执行。
- 测试音频来自 Microsoft Zira en-US，仅用于本地测试 Worker 合同；未安装或验收真实 eSpeak NG，不得宣称真实离线 TTS 引擎已通过。
- 未运行 Hosted CI。
- 未做生产部署、生产浏览器回归或客户验收。
