# 导演台人物、机位与灯光规格符合性报告

## 结论

通过。代码差异与 `docs/director-stage-neodomain-parity-20260730.md` 的任务边界一致，没有发现阻断发布的规格偏差、伪交互或禁止性回归。

本仓库未提供本任务对应的 `03_visual_spec`、`04_visual_spec_review`、`05_design_system` 或 OpenSpec 文件，因此本轮以已确认任务文档、现有导演台交互契约和自动化测试为事实源。该缺口记为非阻断流程警告，不推测未记录的视觉细节。

## 审计范围

- `frontweb/src/components/dramaCanvas/CanvasDirectorStage.vue`
- `frontweb/src/utils/directorTimeline.js`
- `frontweb/test/directorStageIntegration.test.js`
- `frontweb/test/directorTimeline.test.js`
- `frontweb/e2e/director-neodomain-parity.spec.js`
- `docs/director-stage-neodomain-parity-20260730.md`

## 符合性矩阵

| 要求 | 实现证据 | 验证 | 结果 |
| --- | --- | --- | --- |
| 人物任意子网格选择统一到根对象 | 变换选择与保存链统一解析导演对象根节点 | 根对象拖动与属性保存 E2E | 通过 |
| 机位角度可编辑并持久化 | 方位角、仰角、距离、横滚角同步相机、机位对象和时间线 | 机位定向单测与 E2E | 通过 |
| 灯光是实际 3D 对象 | 灯光对象保存类型、颜色、强度、角度、距离并创建 DirectionalLight | 三点布光 E2E 与可见界面审计 | 通过 |
| 18 个灯光预设 | `LIGHTING_PRESETS` 暴露 18 个可操作预设 | 集成测试与浏览器可访问树 | 通过 |
| 三点布光生成三盏灯 | 预设创建主光、辅光、轮廓光三个对象 | 保存回读 E2E | 通过 |
| 灯光新增、选择、编辑 | 场景树、灯光列表和属性检查器共用选中对象 | 浏览器可访问树与截图审计 | 通过 |
| 统一撤销、重做、保存 | 灯光和机位修改进入现有 `commitTimeline` 链 | 集成测试与界面状态 | 通过 |
| 不影响任务外功能 | 差异仅涉及导演台、时间线工具、测试和文档 | `git diff` 文件边界审计 | 通过 |

## UI 与交互审计

- 页面类型：沉浸式 3D 场景编辑弹窗，保留“场景树—视口—属性检查器”三栏结构。
- 新控件落在既有属性检查器内，没有新建孤立页面或卡片式仪表盘。
- 滑杆、输入框、选择器均由可访问标签关联；颜色预设按钮包含名称型 `aria-label`。
- 三点布光后，场景树和灯光列表同时出现三盏灯，当前灯光的参数编辑区可滚动到达。
- 可见界面审计分辨率为 Playwright 默认桌面视口；右侧检查器采用内部滚动，未出现遮挡主视口的新增浮层。

## 验证证据

- 导演台定向 Node 测试：66/66。
- Playwright 隔离端口交互：3/3。
- 前端完整 Node 测试：470/476；6 项为未触及文件中的既有基线失败，没有新增失败。
- 后端完整测试：550/550。
- 前端生产构建：通过。
- Playwright CLI 可见界面：三点真实布光、灯光参数区可见，控制台无错误。

## 发布判断

允许进入 PR 和 CI。合并前仍需以最新 `origin/main` 重新确认差异边界及门禁结果；线上部署后需回归导演台打开、三点布光、灯光切换和机位角度保存。
