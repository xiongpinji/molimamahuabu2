# 图片节点工具栏 P11：真实 3D 角色姿势预演验证报告

## 结论

- 状态：通过
- 范围：图片节点“姿势”入口
- 实现边界：复用现有 Three.js 3D 导演台、程序化人体骨骼和既有 `director_timeline` 持久化链；当前图片只作为构图参考，不声称对图片人物自动绑骨。
- 明确排除：未增加“核验”、侵权检测或版权判断功能。
- 发布边界：仅本地独立 worktree 验证；未推送、未创建 PR、未部署。

## 功能链验证

隔离环境：

- 前端：`http://127.0.0.1:5699/canvas/1`
- 后端：`http://127.0.0.1:3033`
- 独立数据库：`C:\Users\canqu\AppData\Local\Temp\molimama-image-tools-e2e-20260728\drama.sqlite`
- 独立存储：`C:\Users\canqu\AppData\Local\Temp\molimama-image-tools-e2e-20260728\storage`

真实浏览器步骤与证据：

1. 选择 `free:image:e2e`，从图片节点“工具”菜单进入“姿势”。
2. 进入后打开 3D 导演台动画工作区，显示“3D 角色姿势预演，不直接修改原图”。
3. 初始只有相机对象；入口把焦点放到“添加角色”，没有静默新增角色：
   - `canvas_layout.updated_at` 保持 `2026-07-29T00:44:56.031Z`；
   - 对象数保持 1；
   - 原图 URL 保持不变。
4. 用户显式点击“添加角色”后，后端新增一个真实 `humanoid` 对象：
   - `id=object-f1be1400`；
   - `name=男性素体 1`；
   - 初始 `poseRotations={}`。
5. 点击“招手”后，骨骼姿势写入同一条导演时间线：
   - `rightShoulder=[-1.2217304763960306, 0, 0.6108652381980153]`；
   - `rightElbow=[1.4835298641951802, 0, 0]`。
6. 刷新页面并重新进入“姿势”后：
   - 仍只有 1 个 `humanoid`，没有重复创建；
   - “骨骼姿态”面板自动获得焦点；
   - UI 恢复“右肩前举 -70”“右肘弯曲 85”；
   - 后端回读的弧度值与刷新前一致。
7. 整条操作链未替换原图：
   - 原图 URL 始终为 `/static/projects/0001_20260728_图片节点工具栏隔离验收/assets/derived/1785259311946-448303ec-fa27-4afa-bf29-179b2a03ba05.webp`；
   - `imageToolHistory` 长度始终为 6；
   - 后端日志中没有 `POST /api/v1/image-tools/operations`。
8. 浏览器控制台没有 error 或 warning，仅有 Vite 连接和 ThreePipe 初始化日志。
9. 验收结束后关闭本地标签页和服务，3033、5699 端口均确认释放。

## 自动化验证

- P11 定向后端测试：28/28 通过。
- P11 定向前端测试：38/38 通过。
- 后端全量测试：459/459 通过，19 个 suite，0 失败。
- 前端全量测试：337/337 通过，0 失败。
- 前端生产构建：通过，1781 个模块完成转换。
- 后端 `npm audit --registry=https://registry.npmjs.org --json`：0 漏洞。
- 前端 `npm audit --registry=https://registry.npmjs.org --json`：0 漏洞。

说明：后端首次使用本机 `npmmirror` 配置执行审计时，该镜像返回“security audit endpoint not implemented”；随后显式切换 npm 官方审计端点完成复核，结果为 0 漏洞。

## 隔离与真实性审计

- 只修改 P11 所需入口、3D 姿势面板、能力声明、测试、规格和本报告。
- 姿势入口不调用图片处理供应商，不生成或替换图片资产。
- 只有用户显式添加角色、调整姿势时才写入 `director_timeline`。
- 程序化人体使用真实 Three.js 骨骼层级；已加载的 GLTF/VRM 角色继续使用既有真实骨骼编辑链。
- 原仓库既有 `frontweb/e2e/project-canvas-backend-integration.spec.js` 修改未触碰。
- `.worktree-ports.json` 仅为本地隔离端口记录，不纳入提交。
