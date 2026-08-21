# 视觉分析

## 1. 全局构图

- **UI Type**：`application-dashboard`
- **UI Type Confidence**：`0.93`（high）
- **参考图尺寸**：`2048 × 1100 px`
- **宽高比**：约 `1.862:1`
- **主视觉模型**：`structured-layout`

参考图的浏览器工具栏不属于产品页面。产品可见区域从约 `y: 126 px` 开始。

### UI Type Rationale

1. 页面由明确的分段控件、动作按钮和重复套餐卡片组成。
2. 卡片使用规则网格，无照片级场景或全屏主视觉资产。
3. 页面主要任务是比较套餐并执行购买，符合应用内计费面板。

### Visible Element Inventory

| 元素 | bbox | 视觉证据 | Source | Confidence |
|------|------|----------|--------|------------|
| 黑色页面背景 | `x: 0, y: 126, w: 2048, h: 974` | 浏览器区域下方为近黑整页背景 | `reference-visible` | 0.98 |
| 顶部分隔线 | `x: 27, y: 203, w: 2010, h: 2` | 横贯页面的暗灰细线，中间有白色短线 | `reference-visible` | 0.92 |
| 年付/月付分段控件 | `x: 877, y: 258, w: 313, h: 70` | 深灰胶囊，左侧年付高亮 | `reference-visible` | 0.96 |
| 两个橙色动作按钮 | `x: 1545, y: 259, w: 456, h: 68` | 购买积分、购买礼品卡 | `reference-visible` | 0.96 |
| PLUS 卡片 | `x: 69, y: 401, w: 468, h: 635` | 深灰高卡片、价格与按钮 | `reference-visible` | 0.95 |
| PRO 卡片 | `x: 556, y: 401, w: 468, h: 635` | 紫色高卡片、可调积分滑轨 | `reference-visible` | 0.95 |
| MAX 卡片 | `x: 1043, y: 401, w: 468, h: 635` | 蓝灰高卡片 | `reference-visible` | 0.95 |
| ULTRA 卡片 | `x: 1530, y: 347, w: 469, h: 689` | 蓝色顶部提示条与深色卡片 | `reference-visible` | 0.93 |
| 折扣角标 | 每张卡右上约 `w: 100, h: 44` | 橙红胶囊及星标文字 | `reference-visible` | 0.94 |
| 大价格文本 | 每张卡中上部约 `w: 230, h: 72` | 白色大号人民币价格 | `reference-visible` | 0.95 |
| 双指标区域 | 每张卡底部约 `w: 397, h: 108` | 两个等宽圆角信息块 | `reference-visible` | 0.94 |
| 购买按钮 | 每张卡底部约 `w: 397, h: 69` | 高对比圆角按钮 | `reference-visible` | 0.96 |

### Rejected Assumptions

| 假设组件/结构 | 拒绝原因 | 影响 |
|---------------|----------|------|
| 真实月付/年付订阅 | 截图可见控件，但用户明确只借鉴视觉 | 不新增订阅数据模型 |
| 礼品卡购买 | 用户明确保持充值与套餐业务 | 不新增礼品卡入口 |
| 套餐广告图 | 竞品截图的卡片没有独立大广告图 | 作为用户批准的 `inferred-implementation` 实现，不标为竞品事实 |
| 积分滑轨 | 只在 PRO 卡可见，且当前业务不需要用户调整套餐积分 | 不实现滑轨 |
| 原价与折扣价 | 当前套餐模型没有原价字段 | 不新增原价；角标使用管理员文案或计算出的赠送比例 |

### Asset Strategy

| 资产/视觉层 | 实现方式 | 原因 | Source | Confidence |
|-------------|----------|------|--------|------------|
| 套餐广告图 | 管理员上传 raster 图片 | 用户明确要求每个套餐使用大广告图 | `inferred-implementation` | 0.98 |
| 页面、卡片、角标、按钮 | HTML/CSS | 边界清晰，属于结构化 UI | `reference-visible` | 0.95 |
| 茉莉妈妈标识 | 复用项目现有品牌资产 | 不从竞品截图提取品牌 | `inferred-implementation` | 0.98 |

## 2. 颜色系统

| Token 名 | Hex | 角色 | 出现位置 | Source | Confidence |
|----------|-----|------|----------|--------|------------|
| `background.page` | `#050505` | background | 页面底色 | `screenshot-estimated` | 0.88 |
| `surface.card` | `#181818` | surface | 普通套餐卡 | `screenshot-estimated` | 0.82 |
| `surface.purple` | `#292236` | secondary | PRO 卡片 | `screenshot-estimated` | 0.78 |
| `surface.blue` | `#1D2634` | secondary | MAX 卡片 | `screenshot-estimated` | 0.78 |
| `accent.orange` | `#FF7139` | primary | 茉莉妈妈 CTA 与光晕 | `inferred-implementation` | 0.98 |
| `accent.badge` | `#FF8054` | accent | 折扣/赠送角标 | `screenshot-estimated` | 0.84 |
| `text.primary` | `#F7F7F7` | text-primary | 标题与价格 | `screenshot-estimated` | 0.9 |
| `text.secondary` | `#A7A7AD` | text-secondary | 比例与说明 | `screenshot-estimated` | 0.84 |
| `text.muted` | `#77777E` | text-muted | 次要提示 | `screenshot-estimated` | 0.75 |
| `border.default` | `#303030` | border | 卡片和控件边框 | `screenshot-estimated` | 0.82 |

对比度仅为目视估算。实现阶段必须用自动化工具验证正文和按钮对比度。

## 3. 字体排印

| 语义角色 | 字体族 | 字号 | 字重 | 行高 | 颜色 Token | Source | Confidence |
|----------|--------|------|------|------|------------|--------|------------|
| 页面标题 | `Inter, PingFang SC, sans-serif` | `42 px` | 800 | 1.15 | `text.primary` | `inferred-implementation` | 0.92 |
| 套餐名称 | 同上 | `22 px` | 800 | 1.25 | `text.primary` | `screenshot-estimated` | 0.86 |
| 价格 | 同上 | `50 px` | 900 | 1 | `text.primary` | `screenshot-estimated` | 0.9 |
| 正文 | 同上 | `14 px` | 400 | 1.6 | `text.secondary` | `screenshot-estimated` | 0.82 |
| 标签/角标 | 同上 | `12 px` | 800 | 1.2 | `text.primary` | `screenshot-estimated` | 0.83 |

## 4. 间距系统

- **基础单位**：`4 px`
- **页面水平内边距**：桌面 `34 px`，手机 `16 px`
- **卡片间距**：`18 px`
- **卡片内容内边距**：`24 px`
- **网格**：桌面 4 列、平板 2 列、手机 1 列

| 间距 Token | 值 | 用途 | Source | Confidence |
|------------|-----|------|--------|------------|
| `space.1` | `4 px` | 最小节奏单位 | `screenshot-inferred` | 0.75 |
| `space.3` | `12 px` | 小型控件间距 | `screenshot-inferred` | 0.78 |
| `space.4` | `18 px` | 卡片网格间距 | `inferred-implementation` | 0.95 |
| `space.6` | `24 px` | 卡片内容内边距 | `inferred-implementation` | 0.95 |
