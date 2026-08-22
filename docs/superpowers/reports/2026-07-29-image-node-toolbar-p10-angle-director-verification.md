# 图片节点工具栏 P10：3D 机位角度预演验证报告

## 范围与结论

- 本阶段只把图片节点“工具 → 角度”接到项目现有 3D 导演台机位系统。
- 该入口用于 3D 机位角度预演，不直接修改原图，不是图片换视角模型。
- “角度联想”继续保持未接通；没有改变姿势、全景或其他工具能力。
- 本阶段没有加入核验、侵权检测或版权判断。
- 没有新增模型、运行时依赖、接口协议或持久化格式。

## 实现与隔离

- 后端能力表只开放 `angle`：
  - `engine=director-stage`
  - `action=open`
  - `mode=angle`
- 图片节点工具栏把当前图片 URL、节点 ID 和标题传给导演台，不调用图片工具执行接口。
- 角度模式进入动画工作区和导演视角，展示当前图片参考，并明示不直接修改原图。
- 若 `activeCameraId` 对应一个实际存在且 `type=camera` 的真实机位对象，入口会选中机位并定位到现有相机检查器。
- 若当前只有无场景对象的旧导演相机、悬空 `objectId` 或 `objectId` 指向非相机对象，入口不静默新增数据，只聚焦“添加机位”按钮。
- 用户明确添加机位后，继续复用现有 Three.js 相机对象、构图预设、FOV、画幅、位置、旋转和画布时间线持久化链。
- 原图只作为构图参考；机位截图需要用户另行明确触发，并走既有新素材回写链。

## TDD 与自动化验证

红灯阶段：

- 后端能力测试因 `angle.available=false` 失败。
- 前端桥接、入口模式、机位聚焦和不静默创建约束测试均按预期失败。

绿灯与正式回归：

- 后端图片工具目标测试：1/1 通过。
- 前端图片工具栏、导演台桥接与导演时间线目标套件：68/68 通过。
- 悬空机位对象 ID 与指向普通对象的错类型 ID 分别由可执行用例覆盖，均确认降级为空。
- 后端正式全量 `node --test 'test/*.test.js'`：459/459 通过，19 个套件，0 失败。
- 前端正式全量 `node --test 'test/*.test.js'`：336/336 通过，0 失败。
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
2. 选中图片节点，打开“工具”，确认“角度”真实可见并可点击。
3. 首次点击“角度”：
   - 打开 `3D 导演台`；
   - 显示当前图片参考和“3D 机位角度预演，不直接修改原图”；
   - 进入动画工作区；
   - 当前没有真实机位对象，因此只聚焦“添加机位”；
   - 入口打开期间没有后端写请求，也没有静默创建机位。
4. 用户明确点击“添加机位”，右侧出现真实相机检查器。
5. 选择 `45° 俯拍`，把画幅改为 `9:16`，把 FOV 改为 `62`。
6. 后端 API 回读隔离数据库，确认真实相机对象、机位状态和画布时间线已保存。
7. 关闭导演台并刷新页面，再次从图片节点进入“角度”：
   - 自动选中已保存机位；
   - 相机检查器回读 FOV `62`；
   - 画幅回读 `9:16`；
   - 机位位置回读 `[5, 5, 5]`。
8. 整个过程没有出现 `POST /api/v1/image-tools/operations`，源节点图片 URL 保持不变。

本次浏览器同链覆盖正常机位的新增、保存和刷新回读；悬空及错类型对象引用不伪造浏览器数据，改由上文两条可执行自动化用例覆盖。

后端回读：

```text
director_timeline.revision=8
director_timeline.sequence.activeCameraId=camera-55038cc5
camera.id=camera-55038cc5
camera.objectId=camera-object-40cdd2e0
camera.fov=62
camera.aspect=0.5625
cameraObject.position=[5,5,5]
free:image:e2e.url=/static/projects/0001_20260728_图片节点工具栏隔离验收/assets/derived/1785259311946-448303ec-fa27-4afa-bf29-179b2a03ba05.webp
```

## 验收标记

```text
implemented=true
real_browser_verified=true
backend_readback=true
image_operation_posted=false
source_image_replaced=false
silent_camera_creation=false
artifact_verified=not_applicable
failure_writeback=not_applicable
real_provider_verified=not_applicable
productComplete=false
```

`artifact_verified` 和 `failure_writeback` 不适用于本阶段，因为“角度”只打开真实 3D 机位预演，没有触发图片生成。机位截图只有在用户主动点击后才会生成新素材。

## 未解除的发布阻断

- 图片换视角和“角度联想”没有接通可商用、可本地验证的真实生成模型。
- 姿势、全景、画面联想、三视图、九宫格、前后帧推演和对口型等非核验功能仍需逐项实现与验收。
- 全部非核验功能完成并通过总审计前，不推送、不创建 PR、不部署。

## 本地验证环境清理

- 已关闭本地验收标签，预先存在的标签保持未操作。
- 已停止端口 `3033` 与 `5699`，并确认均不再监听。
- 临时数据库和素材保留在独立临时目录，未写入日常项目数据。
