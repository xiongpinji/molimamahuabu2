# 3D 导演台真实后端同链验证

日期：2026-07-24

## 验证目标

确认 3D 导演台的镜头实体、转场参数、角色轨道和动作片段不是仅保存在前端状态中，而是能够经真实 HTTP 接口写入 SQLite，并在页面刷新后恢复到浏览器界面。

## 验证链路

1. Playwright 启动真实前端和独立 Node 后端。
2. 后端使用临时配置、临时 SQLite 和本地存储目录。
3. 浏览器进入项目画布并打开 3D 导演台。
4. 编辑镜头名称、溶解转场、转场时长和角色 `Wave` 动作片段。
5. 测试直接读取 SQLite 中 `dramas.metadata.canvas_layout.director_timeline`，核对镜头与动作数据。
6. 关闭导演台并刷新页面，再次打开后核对 UI 恢复结果。

覆盖的真实接口：

- `GET /api/v1/dramas/:id`
- `PUT /api/v1/dramas/:id/canvas-layout`

## 自动化用例

文件：`frontweb/e2e/project-canvas-backend-integration.spec.js`

用例：`3D 导演台通过真实后端保存镜头与角色动作并在刷新后恢复`

定向执行：

```powershell
$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:31987'
$env:PLAYWRIGHT_REUSE_SERVER='0'
npx playwright test e2e/project-canvas-backend-integration.spec.js --grep "3D 导演台通过真实后端" --workers=1
```

结果：`1 passed`

## 证据边界

本验证证明浏览器、真实后端、SQLite 和刷新恢复处于同一条链路。它不证明专业角色模型、动作文件加载或最终视频导出已通过生产资源验收；这些仍需使用真实 GLB/VRM、动作资源和渲染产物继续验证。

## CC0 角色资产上传与复用补充验证

使用仓库已留档的 Khronos SimpleSkin（CC0-1.0）嵌入式 glTF，在测试内按 glTF 2.0 容器规范封装为 GLB，不下载或引入新的第三方素材。

浏览器同链覆盖：

1. 通过“上传角色模型”控件提交有效 GLB。
2. 真实后端把文件写入项目 `models` 目录并创建 `model/director` 素材记录。
3. 导演时间线保存 `modelUrl` 和 `modelAssetId`。
4. 项目三维素材下拉框读回该素材，并可重新应用为角色模型。
5. Three.js 加载结果包含 1 个可见网格、2 个骨骼和 1 个动画。
6. 刷新后素材库、角色模型 URL、SQLite 绑定和模型加载状态恢复。

自动化用例：`3D 导演台通过真实后端上传 CC0 角色资产并从素材库刷新恢复`

定向结果：`1 passed`

该补充验证证明了授权验证资产的上传、素材库复用、导演台加载和持久化恢复；它仍不等同于专业 VRM 语义、跨骨架动作重定向、IK 或电影级角色资产验收。
