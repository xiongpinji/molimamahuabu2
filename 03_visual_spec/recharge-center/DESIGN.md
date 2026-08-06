# 充值中心视觉设计

## 事实来源

- reference.png：`C:\Users\canqu\AppData\Local\Temp\codex-clipboard-233706bd-4eef-47d4-a1a3-244d15b9bd52.png`
- 提取日期：2026-08-06
- uiType：`application-dashboard`
- 置信度摘要：高 32 / 中 4 / 低 0
- 需人工确认：4 项
- 需脚本验证：4 项

## 能力边界

- LLM 估算项：竞品颜色、字体大小、间距、卡片 bbox 和阴影。
- 需脚本验证项：精确颜色、WCAG 对比度、广告图裁切和视觉回归。
- 需人工确认项：真实广告图片下的安全区、最终品牌观感和移动端密度。

## 可见元素证据

竞品截图可确认：近黑全屏背景、顶部胶囊分段控件、4 列高套餐卡片、醒目价格、橙红角标、双指标区和大号购买按钮。竞品截图没有独立广告图；茉莉妈妈的大广告图是用户明确批准的产品改造。

## Asset Strategy

- 套餐广告图使用管理员上传的 raster 图片。
- 页面、卡片、角标、文字、按钮和遮罩使用 HTML/CSS。
- 品牌标识复用项目现有资产，不提取或复制竞品品牌。

## 布局概览

- 独立 `/recharge` 全屏充值中心。
- 桌面 4 列、平板 2 列、手机 1 列。
- 套餐卡片广告图区高 `230 px`，占卡片约 40% 至 45%。
- 自定义充值使用左右双栏，窄屏折叠为单栏。
- 管理后台采用套餐列表、编辑表单、实时预览三栏结构。

## 组件架构

核心组件为 `RechargeCenterPage`、`RechargePackageCard`、`CustomRechargePanel`、`RechargeOrderDrawer` 和 `RechargePackageAdminPanel`。详细边界见 `component-tree.md`。

## 设计 Token

| 类别 | 关键值 |
|------|--------|
| 页面背景 | `#050505` |
| 卡片背景 | `#181818` |
| 茉莉主色 | `#FF7139` |
| 角标色 | `#FF8054` |
| 主文字 | `#F7F7F7` |
| 卡片圆角 | `24 px` |
| 网格间距 | `18 px` |

完整 Token 与来源置信度见 `tokens.json`。

## 实现风险

主要风险是推荐套餐唯一性、管理员上传权限、支付暂停状态仍误发订单、拖动排序的原子一致性以及动态图片的文字可读性。对应措施见 `implementation-risks.md`。
