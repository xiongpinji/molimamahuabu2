# 图片节点工具栏 P9：3D 灯光预演验证报告

## 范围与结论

- 本阶段只把图片节点顶层“灯光”入口接到项目现有 3D 导演台灯光控制。
- 该入口用于以当前图片为参考进行 3D 灯光预演，不直接修改原图。
- “电影级光影校正”继续保持未接通；没有把 3D 预演冒充图片重打光。
- 本阶段没有加入核验、侵权检测或版权判断，也没有改动其他工具的能力状态。
- 没有新增模型、运行时依赖、接口协议或持久化格式。

## 实现与隔离

- 后端能力表只开放 `lighting`，声明：
  - `engine=director-stage`
  - `action=open`
  - `mode=lighting`
- 前端工具栏把当前图片 URL、节点 ID 和标题传给导演台，不调用图片工具执行接口。
- 导演台灯光模式：
  - 切换到场景检查器；
  - 自动定位 3D 灯光控制；
  - 展示当前图片参考；
  - 明示“3D 灯光预演，不直接修改原图；截图会生成新素材”。
- 环境光和方向光继续复用既有 Three.js 场景灯光与画布时间线持久化链。
- 浏览器验收发现并修复工具栏父级悬停/选中选择器受 Vue `scoped` 样式隔离的问题；修复后真实页面可见并可点击。

## 依赖与许可边界

- 本阶段复用仓库已有 Three.js 导演台，没有引入新的第三方依赖。
- 没有接入 IC-Light：
  - IC-Light V2 官方讨论标注非商业许可；
  - IC-Light V1 官方仓库说明其默认背景移除组件需要替换为可商用实现。
- 在许可、模型来源和真实本地推理链完成审计前，“电影级光影校正”保持不可用。

## 自动化验证

- 后端图片工具目标套件：28/28 通过。
- 前端图片工具栏与导演台目标套件：36/36 通过。
- 后端正式全量 `node --test 'test/*.test.js'`：459/459 通过，19 个套件，0 失败。
- 前端正式全量 `node --test 'test/*.test.js'`：333/333 通过，0 失败。
- 前端 `npm run build`：通过；仅保留项目既有的大分块警告。
- 后端官方 npm registry 审计：0 vulnerabilities。
- 前端官方 npm registry 审计：0 vulnerabilities。
- `node --check src/routes/imageTools.js`：通过。
- `git diff --check`：通过，仅有 Git 的 LF/CRLF 工作区提示。
- 变更产品代码扫描没有出现核验、侵权检测、版权检测或对应英文实现。

## 本地浏览器同链验证

隔离环境：

- 工作树：`C:\Users\canqu\Documents\茉莉妈妈2\wt-image-node-toolbar`
- 数据库：`C:\Users\canqu\AppData\Local\Temp\molimama-image-tools-e2e-20260728\drama.sqlite`
- 素材目录：`C:\Users\canqu\AppData\Local\Temp\molimama-image-tools-e2e-20260728\storage`
- 临时后端：`127.0.0.1:3033`
- 临时前端：`127.0.0.1:5699`
- 独立画布：`/canvas/1`
- 源节点：`free:image:e2e`

浏览器操作与结果：

1. 使用新本地标签进入隔离画布，未操作预先存在的标签。
2. 选中图片节点，确认工具栏真实可见，“灯光”可点击。
3. 点击“灯光”，确认打开 `3D 导演台`，显示当前图片参考和不修改原图的边界说明。
4. 确认属性检查器自动定位到 `3D 灯光`，并显示真实环境光、方向光控件。
5. 把环境光从 `1` 改为 `1.7`，方向光从 `2` 改为 `2.6`。
6. 关闭导演台并通过后端 API 回读隔离数据库，确认 `director_timeline.environment` 已持久化。
7. 刷新页面并重新从图片节点打开灯光入口，控件回读 `1.7` 和 `2.6`。
8. 灯光入口前后没有出现 `POST /api/v1/image-tools/operations`，因此没有生成图片任务，也没有替换源图。

后端回读：

```text
director_timeline.environment.ambientIntensity=1.7
director_timeline.environment.directionalIntensity=2.6
director_timeline.revision=2
free:image:e2e.url 保持原值
```

## 验收标记

```text
implemented=true
real_browser_verified=true
backend_readback=true
image_operation_posted=false
source_image_replaced=false
artifact_verified=not_applicable
failure_writeback=not_applicable
real_provider_verified=not_applicable
productComplete=false
```

`artifact_verified` 和 `failure_writeback` 不适用于本阶段，因为该入口只打开 3D 灯光预演，没有触发图片生成；用户主动执行导演台截图时才会沿既有链生成新素材。

## 未解除的发布阻断

- “电影级光影校正”尚未接通可商用、可本地验证的真实图片重打光引擎。
- 全景、姿势、角度、画面联想、三视图、九宫格、前后帧推演和对口型等非核验功能仍需逐项实现与验收。
- 全部非核验功能完成并通过总审计前，不推送、不创建 PR、不部署。

## 本地验证环境清理

- 已关闭本地验收标签，预先存在的标签保持未操作。
- 已停止端口 `3033` 与 `5699`，并确认均不再监听。
- 临时数据库和素材仍保留在独立临时目录，未写入日常项目数据。
