# 剧本分析与导演生产包

## 目标

在“首页 / 画布 / 短剧工厂”之外增加独立的“剧本分析”入口。用户先提交完整剧本，由专业短剧导演工作流统一分析，再产出可校订、可追溯、后续可导入画布的结构化生产包。

本模块解决单个图片或视频节点只看到局部上下文的问题。节点侧的提示词优化仍可保留，但必须以本模块批准的角色、场景、道具和连续性规则为上游依据。

## 第一阶段范围

第一阶段交付：

- 独立剧本分析项目，不依赖短剧项目或剧集。
- 保存原始剧本和不可改动事实。
- 异步调用平台现有文本模型完成导演分析。
- 输出角色、场景、道具、分集、分场、分镜和图片/视频提示词。
- 保存版本，页面可以查看结构化结果和审查问题。

第一阶段不包含：

- 积分预估、扣费和失败返还。
- 一键生成画布节点。
- 自动生成图片或视频。
- 多个模型并行重复分析。

这些能力在后续阶段接入，避免第一阶段同时改变计费和画布两条生产链。

## 工作流

第一阶段使用顺序编排，由一次结构化模型调用完成多个专业角色的逻辑协作：

1. 剧本分析师：提取故事事实、人物关系、事件和节奏。
2. 短剧导演：确定分集、分场、表演目标和戏剧冲突。
3. 分镜与摄影：拆分镜头、景别、机位、运动和时长。
4. 美术指导：固定角色、场景、道具和视觉锚点。
5. 连续性监督：检查服装、位置、时间、动作和首尾帧衔接。
6. 提示词编译：生成图片提示词和视频提示词。
7. 审查员：列出冲突、缺失信息和需要人工确认的内容。

后续只有在质量或成本数据证明需要时，才将逻辑角色拆成多次模型调用。

## 原剧本保护

模型必须遵守以下规则：

- `source.source_script` 永远保存用户原文，不用 AI 输出覆盖。
- `source.locked_facts` 是不可修改事实。
- 每个镜头的 `source_basis` 必须说明来源。
- 所有补写、合并、推断和改写都写入 `ai_changes`。
- 模型原始输出的 `approval_status` 固定为 `draft`；成功保存为版本后，系统统一改为 `needs_review`，等待人工审核。
- 不确定内容进入 `review.issues`，不能伪装为原剧本事实。

## 导演生产包契约

生产包的 `schema_version` 固定为 `1.0`：

```json
{
  "schema_version": "1.0",
  "source": {
    "title": "项目标题",
    "source_script": "用户原始剧本",
    "locked_facts": []
  },
  "normalized_script": {
    "logline": "",
    "genre": "",
    "tone": "",
    "target_duration_seconds": 0,
    "story_structure": []
  },
  "character_bible": [],
  "scene_bible": [],
  "prop_bible": [],
  "episodes": [
    {
      "episode_number": 1,
      "title": "",
      "scenes": [
        {
          "scene_number": 1,
          "shots": [
            {
              "shot_number": 1,
              "source_basis": [],
              "image_prompt": "",
              "video_prompt": "",
              "continuity": {},
              "dialogue": []
            }
          ]
        }
      ]
    }
  ],
  "continuity_rules": [],
  "review": {
    "status": "needs_review",
    "issues": []
  },
  "ai_changes": [],
  "approval_status": "draft"
}
```

角色、场景和道具条目必须包含稳定 ID，后续画布导入使用这些 ID 维持跨镜头一致性。

## 数据与接口

数据表：

- `script_analysis_projects`：当前项目、原剧本、最新生产包和状态。
- `script_analysis_versions`：每次成功分析的不可变版本。

认证接口：

- `POST /script-analysis/projects`
- `GET /script-analysis/projects`
- `GET /script-analysis/projects/:id`
- `GET /script-analysis/projects/:id/versions`
- `PUT /script-analysis/projects/:id`
- `POST /script-analysis/projects/:id/review`
- `POST /script-analysis/projects/:id/run`

分析任务复用平台现有 `/tasks/:task_id` 查询接口，资源标识为 `script-analysis:<project_id>`。

## 状态与失败规则

项目状态：

- `draft`：已保存，尚未分析。
- `analyzing`：导演工作流执行中。
- `needs_review`：分析成功，等待人工校订。
- `failed`：分析失败，保留原剧本和上一个成功版本。

任务失败必须写回可读原因。模型返回非 JSON、生产包缺少核心数组或接口错误均视为失败，不生成空版本。

## 后续阶段

1. 增加角色、场景、道具、分镜逐项校订和版本差异对比。
2. 增加自动一致性检查，并将 `approved` 设为画布导入的强制门禁。
3. 将批准版本一键转换为画布节点、连线和素材。
4. 保留从生产包条目到原剧本文本及画布节点的来源追踪。
5. 在生产链稳定后接入模型价格预估、积分预占、完成扣费和失败返还。

## 补丁级交付边界

- 所有改动先在本地实现、测试和审计，验收前不部署。
- 专属文件按文件交付；共享文件只交付本任务对应的精确接入片段。
- 禁止同步整个仓库或覆盖线上目录，必须保留其他会话的并行修改。
- 部署前生成逐文件清单，记录目标文件、精确变更、备份位置和回滚方式。
- 密钥、令牌、数据库文件、用户素材和运行时目录不得进入补丁或 Git。

本阶段专属文件：

- `backend-node/migrations/38_script_analysis.sql`
- `backend-node/src/routes/scriptAnalysis.js`
- `backend-node/src/services/scriptAnalysisService.js`
- `backend-node/test/scriptAnalysisService.test.js`
- `backend-node/test/scriptAnalysisRoutes.test.js`
- `frontweb/src/api/scriptAnalysis.js`
- `frontweb/src/views/ScriptAnalysis.vue`
- `docs/SCRIPT_ANALYSIS_DIRECTOR_WORKFLOW.md`

本阶段共享文件只允许交付以下接入片段：

- `backend-node/src/routes/index.js`：注册剧本分析路由对象及七个 `/script-analysis` 接口。
- `frontweb/src/router/index.js`：注册 `/script-analysis` 页面路由。
- `frontweb/src/components/CanvasWorkspaceSwitcher.vue`：增加“剧本分析”导航入口及图标导入。

上述共享文件不得整文件覆盖；提交和部署均需使用精确补丁，并在应用前核对目标上下文。

## 第一阶段验收标准

- 登录用户可以创建和查看自己的剧本分析项目。
- 保存后原剧本文字不被模型输出覆盖。
- 有剧本的项目可以创建异步分析任务。
- 成功任务写入一个新版本并返回结构化生产包。
- 页面可查看故事摘要、角色、场景、道具、分镜和审查问题。
- 失败任务有明确原因，原项目仍可修改并重试。
- 后端测试和前端生产构建通过。
