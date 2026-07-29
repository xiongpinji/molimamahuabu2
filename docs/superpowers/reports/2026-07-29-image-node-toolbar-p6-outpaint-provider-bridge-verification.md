# 图片节点工具栏 P6：扩图供应商桥接验证报告

## 范围与结论

- 本阶段仅实现“扩图”，不包含核验、侵权检测或版权判断。
- 复用项目现有图片供应商调用链，没有引入新的运行时依赖或复制第三方私有实现。
- 扩图只在本地私有模式、默认图片配置显式设置 `supports_outpaint=true`，且命中已审计的 Volcengine Seedream 适配器时开放。
- 公开平台模式固定禁用，原因是图片工具链尚未接入公开平台计费与审计闭环。
- 原素材文件不覆盖；成功结果写入新的派生素材、异步任务和节点处理历史。

## 来源与方案审计

- Google Gemini 官方图片生成文档说明图片模型支持“图片 + 文本”的编辑输入：
  <https://ai.google.dev/gemini-api/docs/image-generation>
- 火山引擎 Seedream 官方提示词指南说明参考图生成与图片编辑能力：
  <https://www.volcengine.com/docs/82379/1829186>
- 本阶段复用 `imageClient.callImageApi` 已有协议分发，但自动能力声明只允许已核对请求体的 Volcengine Seedream 路径。
- “支持参考图”不等于“支持扩图”；AIHubCC、Nano Banana、Gemini、Kling、Agnes、DashScope 和通用 OpenAI 兼容配置均不会被自动标记为扩图可用。
- 配置必须显式设置 `supports_outpaint=true`；仅设置参考图能力或仅凭模型名称推断都不会开放。
- 返回前端的能力信息仅包含供应商、协议和模型名，不返回 API Key 或服务地址。

## 实现结果

- 后端新增参考图能力探测，并将确定的 `provider` 与 `model` 锁定到本次扩图调用，避免探测和执行之间漂移。
- 支持 16:9、9:16、1:1、4:3、3:4 五种目标画幅，以及自动、左、右、上、下、四周六种扩展方向。
- 用户补充描述限制为 500 字。
- 参考图在进入真实供应商请求体前转换为 data URL；本地绝对路径、存储根外路径和符号链接目标不会发送给供应商。
- 生成结果只接受受限 data URL 或 HTTPS；每次 DNS 解析和重定向都拒绝回环、私网、链路本地、保留地址及带凭据 URL，下载采用 64 MiB 流式上限，不复用通用无限缓冲下载器。
- 派生目录在供应商调用前完成真实路径校验；junction/symlink 指向项目外时不会发起供应商请求，也不会写出存储根。
- 生成结果必须通过文件存在性、非空、64 MiB 上限、格式、4000 万像素、目标画幅误差不超过 3%，以及宽高不缩小且至少一边实际扩展的校验。
- 单进程内全局同时只允许一个扩图任务，且同一租户同时只允许一个扩图任务进入供应商链；多进程共享并发锁尚未实现。
- 供应商原始错误、返回 URL 和查询参数不写日志；前端与失败任务统一收到“扩图处理失败”。
- 供应商配置表未就绪时能力探测降级为不可用，不再影响其他路由启动。
- 前端工具菜单仅在后端公布能力后启用“扩图”，并提供画幅、方向和补充描述对话框。

## TDD 与自动化证据

红灯阶段：

- 首轮后端测试在扩图能力与执行链出现 2 个预期失败。
- 安全复核补测后，显式能力声明、绝对路径编码、下载上限和日志脱敏出现 4 个预期失败，证明旧链存在对应缺口。

绿灯阶段：

- `node --test test/imageTools.test.js`：26/26 通过。
- `node --test test/imageNodeToolbar.test.js`：10/10 通过。
- 后端正式全量 `node --test test/*.test.js`：457/457 通过，19 个套件，0 失败。
- 前端正式全量 `node --test test/*.test.js`：330/330 通过，0 失败。
- `npm run build`：通过；仅保留项目既有的大分块警告。
- 本机镜像不实现 npm audit API；改用 `npm audit --registry=https://registry.npmjs.org --audit-level=high`。
- 后端 npm 官方审计端点：0 vulnerabilities。
- 前端 npm 官方审计端点：0 vulnerabilities。

覆盖点包括：

- 只有显式设置 `supports_outpaint=true` 的 Seedream 配置开放能力；未声明的 Seedream 和 DALL-E 3 均不误开放。
- 公开平台能力查询和直接 POST 均固定禁用扩图。
- 真实 `callImageApi` 请求体把存储根内绝对参考图编码为 data URL，不包含本地路径。
- 私网/回环 URL、超限 data URL、junction 输出目录被拒绝且不产生越界文件。
- 错误目标画幅和原图回显被拒绝，不写入派生资产。
- 参数、方向提示词、供应商请求和本地派生素材写入。
- 源素材不覆盖。
- 供应商错误不返回前端，失败任务可回读。
- 图片模型配置表不存在时，原有本地管理路由与生成路由仍可注册和运行。

## 浏览器适配器链验证

验证环境：

- 隔离工作树：`C:\Users\canqu\Documents\茉莉妈妈2\wt-image-node-toolbar`
- 临时后端：`127.0.0.1:3033`
- 临时前端：`127.0.0.1:5699`
- 临时适配器：`127.0.0.1:3044`
- 隔离项目：`图片节点智能抠图隔离验收`
- 源节点：`free:image:1785261445656`

安全加固前的浏览器适配器链证据：

1. 选中图片节点，打开“工具”菜单。
2. 确认“扩图”可用，灯光、姿势、角度等未实现能力仍禁用。
3. 选择 16:9、向右扩展，输入“向右补出连续的室内窗景与自然光”。
4. 首次让适配器拒绝输入，确认前端显示通用失败、提供重试，后端任务写回失败。
5. 修正临时适配器协议后从同一对话框重试。
6. 确认处理历史显示“扩图 / 已完成”。
7. 刷新页面后再次确认派生素材和处理历史可回读。
8. 关闭本地验收标签页；用户原有参考站标签页保持打开。

后端回读：

- 失败任务：`8e8ce074-2426-48ff-af54-bc9d5bb81295`
  - `type=image_tool_outpaint`
  - `status=failed`
  - `error=扩图处理失败`
- 成功任务：`5ad7f4f5-aea4-4d9f-bf21-0071e0d94ab8`
  - `type=image_tool_outpaint`
  - `status=completed`
- 派生素材：`asset_id=17`
  - `operation=outpaint`
  - `engine=provider-image-edit`
  - `engineVersion=volcengine:doubao-seedream-4-5-local-adapter`
  - `width=2560`
  - `height=1472`
  - `format=png`
  - 文件存在，大小为 419838 字节
- 本次实际源素材：`asset_id=16`
  - 文件仍存在
  - 没有被覆盖
- 画布回读：
  - 节点历史首项为成功扩图任务
  - 节点当前结果指向 `asset_id=17`
  - 刷新后仍能显示新素材与处理历史

上述记录证明 UI、任务、数据库、文件和失败重试链可贯通，但发生在受限下载与显式 `supports_outpaint` 门禁加固前，只作为历史失败与重试证据保留。

安全加固后的浏览器适配器链复验：

1. 使用独立本地标签页进入 `/canvas/2`，没有切换或关闭用户已打开的参考站标签页。
2. 选中源图片节点，打开“工具”菜单，确认只有后端已公布能力的“扩图”可用；灯光、姿势、角度等未实现能力仍显示“未接通”。
3. 保持 16:9、自动扩展，输入“向右扩展连续室内空间，保持人物和光影风格一致”并提交。
4. 加固适配器只接受 data URL 参考图；收到请求后记录 `referenceType=data-url`，未收到本地绝对路径。
5. 前端显示“图片处理完成，已生成新素材”。
6. 刷新页面，新素材仍出现在素材库，旧素材同时保留。

加固后端回读：

- 成功任务：`cf051b5c-c218-4c35-b2dd-389d4ba3be20`
  - `type=image_tool_outpaint`
  - `status=completed`
  - `progress=100`
  - `resource_id=free:image:1785261445656`
  - `error=null`
- 新派生素材：`asset_id=18`
  - `operation=outpaint`
  - `engine=provider-image-edit`
  - `engineVersion=volcengine:doubao-seedream-4-5-hardened-adapter`
  - `sourceAssetId=17`
  - `width=2880`
  - `height=1620`
  - `mime_type=image/png`
  - 文件存在，大小为 67634 字节
- 本次源素材：`asset_id=17`
  - `width=2560`
  - `height=1472`
  - 文件仍存在，大小仍为 419838 字节
  - 没有被覆盖
- 目标结果为 16:9，宽高均不小于源素材且实际扩展，满足加固后的产物语义门禁。
- 临时供应商配置已从隔离数据库删除；临时适配器与启动脚本已删除，3033、3044、5699 三个验收进程已停止且端口释放。

## 验收标记

```text
implemented=true
provider_adapter_verified=true
real_provider_verified=false
backend_readback=true
artifact_verified=true
failure_writeback=true
productComplete=false
```

`provider_adapter_verified`、`backend_readback` 与 `artifact_verified` 代表加固后真实本地前端、后端、数据库、文件落盘和受限协议适配器的同链验证；不能替代收费真实模型供应商验收。

## 未解除的发布阻断

- 隔离数据库和桌面数据库都没有可用于扩图的真实图片供应商配置。
- 未获得消耗真实模型额度的授权，因此没有发送收费请求。
- 公开平台计费、额度预留、结算和审计事件尚未接入图片工具链。
- 供应商能力在后端启动时解析；新增或切换图片配置后需要重启后端才能刷新工具栏能力。
- 在真实供应商同链验证、全功能总审计和最终回归完成前，不创建 PR、不推送、不部署。
