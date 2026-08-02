# 剧本分析 Skill 运行时一期

## 目标

在现有“剧本分析”流程中加入受控的导演 Skill 选择能力，同时保持两个既有事实不变：

1. 用户上传或输入的原剧本只作为事实源保存，分析结果不得覆盖原文。
2. 审核通过后的生产包继续导入现有独立画布 `/canvas/local`，不创建第二套画布实现。

一期只支持平台内置、随代码发布并经过审核的提示词 Skill。它不是任意脚本执行器，也不从第三方仓库下载和运行代码。

## 范围

- 提供可公开读取的 Skill 清单，包含名称、版本、说明和输出协议版本。
- 运行分析时由用户选择一个已启用的 Skill；未选择时使用平台默认 Skill。
- 每次分析把所用 Skill 的不可变元数据快照写入该分析版本的 `package_json`。
- 前端展示 Skill 选择器，并在分析结果中显示实际使用的 Skill 与版本。
- 继续沿用现有项目、审核、版本和画布导入接口。

## 非目标

- 不允许用户上传或执行 JavaScript、Python、Shell 或其他任意代码。
- 不在前端暴露系统提示词、API Key 或供应商配置。
- 不改变独立画布的数据结构、路由或交互。
- 不在一期提供在线安装、热更新、Skill 商店或第三方仓库自动同步。

## 接口契约

### 查询可用 Skill

`GET /api/v1/script-analysis/skills`

响应仅返回安全元数据：

```json
{
  "skills": [
    {
      "id": "short-drama-director",
      "name": "专业短剧导演",
      "version": "1.0.0",
      "description": "将原剧本整理为可审核、可导入画布的短剧生产包",
      "module": "script_analysis",
      "output_schema_version": "1.0",
      "is_default": true
    }
  ]
}
```

系统提示词不得出现在响应中。

### 运行分析

`POST /api/v1/script-analysis/projects/:id/run`

请求体：

```json
{
  "skill_id": "short-drama-director"
}
```

- `skill_id` 可省略，省略时使用默认 Skill。
- 未知、禁用或不属于 `script_analysis` 模块的 Skill 返回 `400`，不得创建任务或扣费。
- 分析异步执行方式与现有接口保持一致。

## 版本快照

成功分析生成的生产包新增：

```json
{
  "skill_snapshot": {
    "id": "short-drama-director",
    "name": "专业短剧导演",
    "version": "1.0.0",
    "module": "script_analysis",
    "output_schema_version": "1.0"
  }
}
```

快照来自运行开始时解析出的内置 manifest。后续 Skill 升级不得修改历史版本中的快照。

## 安全边界

- 运行时只从代码内的白名单注册表解析 Skill。
- 前端提交的 `skill_id` 只用于白名单查找，不能转换为文件路径或模块名。
- API 不返回系统提示词。
- Skill 必须声明模块和输出协议版本；服务端仍执行现有生产包结构校验。
- 模型输出中的 `source` 继续由服务端以项目原始输入覆盖，避免模型改写事实源。

## 验收标准

1. Skill 清单接口返回默认导演 Skill，且不包含 `system_prompt`。
2. 不传 `skill_id` 可继续运行；传入有效 Skill 可运行；无效 Skill 在创建异步任务前返回 `400`。
3. 每个成功分析版本都包含 `skill_snapshot`。
4. 原剧本和锁定事实仍由服务端回填，模型输出无法覆盖。
5. 前端可以选择 Skill，并将选择结果传给运行接口。
6. 审核通过后仍写入 `HOME_CANVAS_STORAGE_KEY` 并跳转 `/canvas/local`。
7. 后端相关测试、前端构建和现有画布导入测试全部通过。

## 回滚

本期不新增数据库迁移。回滚代码后，历史 `package_json` 中的 `skill_snapshot` 会作为额外 JSON 字段保留，旧代码可忽略该字段；既有项目、版本和画布数据无需转换。
