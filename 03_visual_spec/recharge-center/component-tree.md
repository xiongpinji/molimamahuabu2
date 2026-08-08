# 组件树

## UI Type

- **值**：`application-dashboard`
- **组件树模型**：`pricing-grid-with-admin-editor`

## 用户端

```text
RechargeCenterPage [source: inferred-implementation]
├── RechargeTopBar [source: inferred-implementation]
│   ├── BrandIdentity
│   ├── CurrentCreditBalance
│   ├── RechargeHistoryTrigger
│   └── CloseButton
├── RechargeHero [source: inferred-implementation]
├── RechargeModeSwitch [source: inferred-implementation]
├── PackageGrid [source: inferred-implementation]
│   └── RechargePackageCard[]
│       ├── PackageAdImage
│       ├── FeaturedLabel
│       ├── BadgeText
│       ├── AdCopy
│       ├── PackagePrice
│       ├── CreditMetrics
│       └── PurchaseButton
├── CustomRechargePanel [source: inferred-implementation]
│   ├── AmountInput
│   ├── QuickAmountButtons
│   ├── CreditPreview
│   ├── RechargeRules
│   └── OrderSummary
└── RechargeOrderDrawer [source: inferred-implementation]
```

`RechargeModeSwitch` 与 `PackageGrid` 的组件层级受截图可见布局启发，但具体业务字段和交互均为茉莉妈妈的实现推断。

## 管理员端

```text
RechargePackageAdminPanel [source: inferred-implementation]
├── PackageSortableList
├── PackageEditorForm
│   ├── PackageImageUploader
│   ├── AdvertisingCopyFields
│   ├── PricingAndCreditFields
│   ├── AvailabilityFields
│   └── PresentationFields
├── PackageLivePreview
└── SaveBar
```

## 组件详情

### RechargePackageCard

- **Source**：`inferred-implementation`
- **尺寸**：桌面网格单元宽度，最小高度 `570 px`
- **广告图**：高度 `230 px`，`object-fit: cover`
- **背景**：`surface.card`，推荐卡可使用强调色混合背景
- **边框**：`border.default`
- **圆角**：`radius.card`
- **内容类型**：图片、文本、金额、状态与按钮
- **Confidence**：0.97

### RechargeModeSwitch

- **Source**：`reference-visible`
- **参考 bbox**：`x: 877, y: 258, w: 313, h: 70`
- **视觉证据**：截图顶部居中的年付/月付胶囊分段控件
- **实现适配**：文案改为「精选套餐 / 自定义充值」
- **Confidence**：0.96

### PackageAdImage

- **Source**：`inferred-implementation`
- **尺寸**：卡片宽度 × `230 px`
- **内容类型**：管理员上传 raster 图片
- **严格度**：recommended
- **Confidence**：0.98

### PackageSortableList

- **Source**：`inferred-implementation`
- **宽度**：桌面 `300 px`
- **内容类型**：缩略图、文本、拖动与键盘排序操作
- **Confidence**：0.95

组件使用的颜色、间距和圆角均在 `tokens.json` 中定义。
