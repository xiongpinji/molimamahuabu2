# 来源可追溯性报告

## 事实源优先级

1. `docs/director-stage-neodomain-parity-20260730.md`：用户确认后的任务边界、参考站已观察行为、缺陷根因和验收标准。
2. 现有 `CanvasDirectorStage.vue` 与 `directorTimeline.js`：项目既有交互、保存和状态模型。
3. 新增单元、集成和 E2E 测试：可执行行为契约。
4. Playwright CLI 独立端口可见界面审计：仅用于确认呈现和交互可达，不替代代码级验收。

## 要求到源码映射

| 需求 | 源码落点 | 测试落点 |
| --- | --- | --- |
| 人物根对象变换 | `CanvasDirectorStage.vue` 的选择、TransformControls 和保存链 | `director-neodomain-parity.spec.js`、`directorStageIntegration.test.js` |
| 机位角度与持久化 | `cameraPositionFromAngles`、机位更新与绑定相机同步 | `directorTimeline.test.js`、`director-neodomain-parity.spec.js` |
| 灯光数据规范化 | `normalizeLightSettings` 与时间线规范化 | `directorTimeline.test.js` |
| 18 个灯光预设 | `LIGHTING_PRESETS`、`applyLightingPreset` | `directorStageIntegration.test.js` |
| 三点真实布光 | 灯光对象创建和 ThreePipe 场景同步 | `director-neodomain-parity.spec.js` |
| 灯光列表与参数编辑 | 属性检查器中的灯光列表和编辑控件 | Playwright 可访问树及 E2E 保存回读 |

## 外部来源边界

- 只复现参考站中已观察、可验证的产品行为。
- 未使用参考站品牌、私有源码、私有接口或不可验证字段。
- ThreePipe 是项目已有运行依赖；本次复用真实 3D 灯光能力，没有引入静态图片或 CSS 伪造结果。

## 缺口

仓库内没有本任务专属视觉规格、视觉评审或 OpenSpec。该缺口不会使已写明的行为验收失效，但不支持宣称未记录区域已经达到像素级一致。
