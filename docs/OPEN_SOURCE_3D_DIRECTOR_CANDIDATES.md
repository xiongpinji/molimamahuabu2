# 3D 导演台开源候选审计

日期：2026-07-14
范围：公开收费平台、浏览器画布、角色/场景/道具、机位、灯光、镜头时间线与可持续维护。

## 结论

当前 `CanvasDirectorStage.vue` 是 `Threepipe` 加本地 box/sphere 几何占位，不是完整导演台。Threepipe 本身提供模型加载、场景、相机、灯光、编辑器和插件能力，但上层的镜头编排、镜头时间线、资产管理、短剧语义仍需要我们自己实现；继续只在现有组件上补 UI，无法达到 LibTV 类导演台的实用程度。

联网筛选后，没有找到一个同时满足以下全部条件的单一仓库：

- 浏览器原生运行并可嵌入现有 Vue 应用；
- 已有影视导演工作流（机位、镜头切换、时间线、资产管理）；
- 支持我们需要的通用 3D 资产格式；
- 代码和随附资产都明确允许公开收费平台商用。

## 候选对比

| 候选 | 已有能力 | 许可证/风险 | 对本项目的判断 |
| --- | --- | --- | --- |
| [culdo/web-mmd](https://github.com/culdo/web-mmd) | Director mode、固定跟随、dope-sheet 时间线、模型/舞台/动作/相机/音乐切换、灯光和变换控件、JSON 预设、镜头构图编辑 | 代码仓库标注 MIT；README 对 demo 模型、动作、音乐等逐项署名，素材不能默认视为 MIT；源码 `app/modules/MMDLoader.ts` 明确只处理 PMD/PMX/VMD/VPD；技术栈是 MMD 专用 three.js 分支、Next.js/React/Theatre.js | **最接近“可用导演工作流”但不是通用资产底座**；可独立运行或提取流程参考，不直接接入当前 GLB/VRM 生产链路 |
| [three.js Editor](https://threejs.org/editor/) | 场景树、对象变换、相机、灯光、材质、脚本、撤销、导入/导出 JSON/GLTF/GLB 等，浏览器可直接运行 | three.js 仓库 MIT；它是通用场景编辑器，没有短剧镜头表、镜头切换和角色动作工作流 | **资产兼容优先时的第二选择**；需要自己补导演语义 |
| [PlayCanvas Editor](https://github.com/playcanvas/editor) | 完整浏览器 3D 编辑器、场景/对象/历史和测试体系，MIT | 本地前端开发仍按官方说明连接 PlayCanvas 站点、场景 ID 和账号；不是可直接嵌入的独立短剧模块 | 能力强但改造和平台耦合较大，不是最小整合路线 |
| [FilmakademieRnd/VPET](https://github.com/FilmakademieRnd/VPET) | 面向虚拟制片的实时场景编辑，覆盖灯光、资产、动画，支持协作 | MIT；客户端是 Unity 的 iOS/Android/Windows 应用，不是浏览器 Vue 组件 | 影视方向最贴近，但应作为流程参考或独立客户端，不作为当前画布替换物 |
| [repalash/threepipe](https://github.com/repalash/threepipe) | 模型加载、渲染、相机、灯光、拾取、变换、插件和 GLB 场景序列化 | Apache-2.0；本项目当前已使用 | **底层工具包，不是完整导演台**；当前占位问题的根因不是缺少一个按钮，而是缺少导演工作流层 |

## 明确排除

- Wonder Unit Storyboarder：仓库存在收费限制例外，不适合作为公开收费平台底座，除非取得书面许可。
- NickPittas/DirectorsConsole：许可证为 proprietary / all rights reserved，不能作为商业平台开源底座。
- StoryBlender：Blender 扩展加 Gradio/代理研究流程，不是可嵌入浏览器导演台。

## 唯一推荐的验证顺序

1. **Web-MMD 源码验证已完成**：拉取到 `research/libtv-open-source-audit/candidates/web-mmd`，`npm install --package-lock=false` 后 `npm run build` 通过；构建有既存 React Hook 警告，且 `npm ci` 因上游 lockfile 与 package.json 不同步而失败。
2. **Web-MMD 已停止作为生产替换候选**：它的核心资产链是 PMD/PMX/VMD/VPD，不满足当前通用 GLB/VRM 短剧资产假设。
3. 下一候选改为 `three.js Editor`：先验证 GLB/GLTF 导入、对象/灯光/相机编辑、JSON/GLB 保存恢复，再评估是否在其上增加短剧镜头表和时间线。
4. 只有候选通过“真实资产 + 机位 + 灯光 + 镜头时间线 + 保存/恢复”验收后，才替换当前 `CanvasDirectorStage.vue`；在此之前不继续扩展现有占位实现。

## three.js Editor 实测记录

验证目录：`research/libtv-open-source-audit/candidates/threejs-editor`（独立候选副本，未修改生产前端）。

执行证据：

- 稀疏检出 `editor`、`src`、`examples/jsm`、构建脚本和许可证文件；编辑器目录 144 个文件。
- `npm install --ignore-scripts --no-audit --no-fund --package-lock=false`：通过，新增 217 个依赖包。
- `npm run build`：通过，Rollup 成功生成 `build/three.core.js`、`build/three.module.js`、`build/three.webgpu.js` 等构建产物。
- 本地静态服务器 `http://127.0.0.1:8765/editor/`：页面标题为 `three.js editor`，可加载并显示场景树、对象统计和编辑菜单。
- 浏览器操作：添加正方体后统计变为 1 个物体 / 24 个顶点 / 12 个三角形；添加平行光后生成 `DirectionalLight` 与 `DirectionalLight Target`；添加透视相机后场景树出现 `PerspectiveCamera`。
- 真实资产导入：通过导入对话框上传 `BoomBox.glb`，确认后场景树出现 `BoomBox.glb`，统计显示 3,575 个顶点 / 6,036 个三角形。
- GLB 导出：通过“文件 → 导出 → GLB”下载 `scene.glb`，文件大小 15,011,020 字节，文件头为 `glTF`；说明候选具备基础场景导出链路。
- 截图证据：`output/playwright/threejs-editor-import.png`。

非阻断问题：浏览器控制台唯一错误是候选静态目录缺少 `/files/favicon.ico`（404）；另有 WebGL 驱动精度 warning。两者均未阻止对象创建、灯光/相机编辑或 GLB 导入。

当前判断：three.js Editor 已通过“可运行 + 基础场景编辑 + GLB 导入”冒烟；第二轮确认项目 JSON 保存/恢复和单角色动画播放可用，但仍未通过短剧导演台的镜头时间线、镜头剪辑切换和多角色动作编排验收，因此暂不替换 `CanvasDirectorStage.vue`。下一步应评估以 Web-MMD 的时间线/导演流程作为上层语义参考，而不是直接合并两套前端。

## 第二轮功能验收

本轮仍只操作隔离候选副本，未改生产前端。测试资产为 three.js 官方示例 `RobotExpressive.glb`，用于覆盖真实角色骨骼动画和多动作片段。

### 场景保存/恢复：通过（通用编辑器级）

- “文件 → 保存”下载 `project.json`，文件大小 1,727,102 字节；解析后包含 `metadata`、`project`、`camera`、`controls`、`scene`、`scripts`、`history` 等顶层字段。
- 保存文件中的场景包含 `PerspectiveCamera` 和 `RobotExpressive.glb` 两个子对象，`scene.animations` 包含 14 个动画片段。
- 为验证不是“保存后原状态仍在”，保存后额外添加 `Box`，再通过“文件 → 打开”上传刚才的 `project.json`；恢复完成后场景树移除 `Box`，保留 `PerspectiveCamera`、`RobotExpressive.glb`，角色动作列表重新出现。
- 结论：three.js Editor 的项目 JSON 保存/恢复链路可用；这不是短剧项目格式，镜头表、镜头段落和角色编排仍不会自动产生。

### 镜头切换：部分通过（活动相机切换，不是镜头剪辑）

- 添加 `PerspectiveCamera` 后，顶部相机选择器出现 `Camera`、`PerspectiveCamera` 两个选项；选择 `PerspectiveCamera` 后选择器状态和视口活动相机同步更新。
- 恢复保存项目后，项目只保留当前活动的 `PerspectiveCamera` 选项，未形成多镜头序列、切点、转场或镜头段落。
- 结论：可切换活动相机，但不具备 LibTV 意义上的镜头切换时间线。

### 镜头时间线：不通过

- 编辑器底部存在时间轴控件，但搜索源码和界面均没有“镜头”“镜头切换”“镜头时间线”等导演语义；该时间轴只展示单个动画剪辑的轨道和关键帧。
- 未发现镜头段落轨道、镜头入点/出点、剪辑顺序、切换点或转场配置。不能用它编排短剧镜头序列。

### 角色动作编排：部分通过（单角色动画剪辑级）

- 导入 `RobotExpressive.glb` 后，时间轴显示 `Dance`、`Death`、`Idle`、`Jump`、`Punch`、`Running`、`Walking`、`Wave`、`Yes` 等动作，以及身体、头部、手臂、腿部的 position/quaternion/morphTarget 轨道。
- 播放 `Dance` 时，时间从 `0.00` 推进到 `0.67` 秒（总长 `3.33` 秒）；选择 `Death` 后总长切换为 `0.96` 秒，再选回 `Dance` 恢复为 `3.33` 秒，证明动作片段选择和播放有效。
- 但没有角色轨道分组、动作片段拼接/混合、动作与镜头联动或多角色编排语义。
- 结论：可作为角色动画预览和单剪辑编辑器，不能直接作为短剧角色动作编排台。

### 第二轮结论

| 能力 | 验收结果 | 可直接用于 LibTV 类导演台吗 |
| --- | --- | --- |
| 场景保存/恢复 | 通过 | 只能作为底层项目序列化 |
| 活动相机切换 | 部分通过 | 不能替代镜头剪辑 |
| 镜头时间线 | 不通过 | 需要新增导演语义层 |
| 角色动作编排 | 部分通过 | 需要动作片段/角色轨道层 |

因此，three.js Editor 适合作为通用 3D 场景、资产和动画底座；若目标是 LibTV 的画布导演台，仍需在其上实现“镜头实体 + 镜头序列/切点 + 角色轨道 + 动作片段 + 项目格式”的导演层，不能把本轮通用动画时间轴误判为完整镜头时间线。

## 公开收费平台的发布边界

- 代码许可证和模型、动作、贴图、音乐、字体、示例预设必须分别审计；不能因为仓库首页显示 MIT 就把 demo 资产一起商用。
- 保留上游 LICENSE/NOTICE 和版权归因。
- 不把远程 demo 资源、作者示例资产或未审计模型带入生产构建。
