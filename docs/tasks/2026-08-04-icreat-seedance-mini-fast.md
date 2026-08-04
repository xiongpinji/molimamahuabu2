# iCreat Seedance 2.0 Mini / Fast 接入

## 目标

- 接入 iCreat 视频模型 `bytedance/seedance-2-0-mini` 与 `bytedance/seedance-2-0-fast`。
- 使用用户提供的 Key 分别完成一次真实生成、等待成功终态并验证结果视频可读取。
- 只有真实验证通过、后台状态为 `verified` 且平台已配置有效积分价格的模型，才允许出现在画布前端目录。
- API Key 只写入生产后台配置，不进入源码、测试、任务文档或日志。

## 官方接口合同

来源：<https://icreat.ai/hub/docs/zh-CN/api/dev-docs.html>

- 提交：`POST https://api.icreat.ai/v1/task/submit/{model}`。
- 状态：`POST https://api.icreat.ai/v1/task/query-status`。
- 结果：`POST https://api.icreat.ai/v1/task/get-result`。
- 鉴权：`Authorization: Bearer <API Key>`。
- Fast / Mini 模型码分别为 `bytedance/seedance-2-0-fast`、`bytedance/seedance-2-0-mini`。
- 两个变体仅支持 `480p`、`720p`；时长为 4 到 15 秒整数或 `-1`。

## 验收门

- [x] 核对生产实时配置、目录和平台价格，不重复建模或覆盖无关配置。
- [ ] Mini 真实生成成功且结果文件可读取。
- [ ] Fast 真实生成成功且结果文件可读取。
- [x] 后端专项测试通过。
- [ ] 全量测试及双轴复审通过。
- [ ] 从实时生产 `current` 构建候选，共享门禁、备份、活动任务和生产预检通过。
- [ ] 生产写入两模型配置并从三套前端目录回读可选择状态。
- [ ] 切换后健康、日志与 AI 音乐隔离检查通过。

## 真实验证记录

- 生产数据库当前没有 iCreat 配置，未覆盖或修改任何现有供应商。
- 平台只有旧模型 `seedance 2.0` 的价格记录；本任务没有擅自复制或新增 Mini / Fast 的积分价格。
- 用户 Key 的只读连接探针通过；密钥长度 51，正文未记录。
- Mini 任务 `task-019fcd3a-6e7f-7f96-9498-5aa7c911852a`：4 秒、480p、16:9，供应商失败终态为余额不足；需要 77,000，现有 43,000。
- Fast 任务 `task-019fcd3a-cbae-7334-adad-1fa48452043b`：4 秒、480p、16:9，供应商失败终态为余额不足；需要 124,000，现有仍为 43,000，证明前一失败任务未扣余额。
- 两个模型均没有生成结果文件，不能标记 `verified`，也不能进入前端目录或生产模型配置。

## 当前结论

代码库已有与官方合同一致的 iCreat Mini / Fast 通用适配器；当前阻塞不是客户端实现，而是用户 Key 的供应商余额不足。至少应把 iCreat 余额充值到可覆盖两次真实验证任务后，重新执行本任务的真实生成门禁。充值完成前不得写入生产配置。
