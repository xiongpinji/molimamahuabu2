# 布局规格

## 整体布局

- **UI Type**：`application-dashboard`
- **容器宽度**：桌面最大 `1520 px`
- **容器高度**：内容驱动，最小 `100vh`
- **布局模式**：CSS Grid + Flex
- **坐标系统**：响应式容器，不使用固定截图坐标

## 用户端充值中心

### 顶部栏

| 属性 | 值 | Source | Confidence |
|------|-----|--------|------------|
| 定位 | `sticky; top: 0` | `inferred-implementation` | 0.92 |
| 高度 | `72 px` | `inferred-implementation` | 0.95 |
| 水平内边距 | `36 px`；手机 `16 px` | `inferred-implementation` | 0.95 |
| 背景 | 半透明近黑 + `backdrop-filter` | `screenshot-inferred` | 0.84 |

### 套餐网格

| 属性 | 值 | Source | Confidence |
|------|-----|--------|------------|
| 桌面列数 | 4 列 | `reference-visible` | 0.96 |
| 平板列数 | 2 列 | `inferred-implementation` | 0.94 |
| 手机列数 | 1 列 | `inferred-implementation` | 0.96 |
| 网格间距 | `18 px` | `inferred-implementation` | 0.95 |
| 单卡最小高度 | `570 px` | `inferred-implementation` | 0.9 |
| 卡片圆角 | `24 px` | `screenshot-estimated` | 0.8 |
| 广告图高度 | `230 px`；手机 `210 px` | `inferred-implementation` | 0.95 |
| 广告图裁切 | `width: 100%; object-fit: cover` | `inferred-implementation` | 0.98 |

### 自定义充值

| 属性 | 值 | Source | Confidence |
|------|-----|--------|------------|
| 桌面布局 | 左 `1.35fr` + 右 `0.65fr` | `inferred-implementation` | 0.95 |
| 网格间距 | `18 px` | `inferred-implementation` | 0.95 |
| 金额输入高度 | `86 px` | `inferred-implementation` | 0.92 |
| 快捷金额 | 桌面 6 列；平板/手机 3 列 | `inferred-implementation` | 0.94 |
| 小于 `850 px` | 订单摘要移动到金额面板下方 | `inferred-implementation` | 0.96 |

## 管理员后台

| 区域 | 桌面宽度 | 小屏行为 | Source | Confidence |
|------|----------|----------|--------|------------|
| 套餐列表 | `300 px` | 小于 `760 px` 改为单列 | `inferred-implementation` | 0.95 |
| 编辑表单 | `minmax(680 px, 1fr)` | 小屏单列 | `inferred-implementation` | 0.95 |
| 实时预览 | `360 px` | 小于 `1180 px` 移到下一行 | `inferred-implementation` | 0.94 |
| 区域间距 | `14 px` | 保持 | `inferred-implementation` | 0.94 |

所有固定尺寸均来自用户已认可的原型，不是竞品截图中的直接测量值。
