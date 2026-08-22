# 开源方案与商用许可证审计

日期：2026-07-14
范围：公开收费平台的画布模式、3D 导演台与宫格分镜适配。

## 选定方案

| 方案 | 用途 | 许可证/结论 |
| --- | --- | --- |
| [Threepipe](https://github.com/repalash/threepipe) | 3D 场景、相机、灯光、拾取、变换控件的导演台底座 | Apache-2.0，当前锁定 `0.5.1`，源码审计提交 `52c3ec1730463d935a582cf999c3eecb0ac63c14` |
| 现有 `sharp` | 已有宫格整图裁剪与本地面板落盘链路 | 沿用现有依赖，不新增图像处理核心 |

Threepipe 的适配范围被限制为：创建导演台容器、映射现有角色/场景/道具数据、设置相机和灯光、复用官方插件。当前导演台使用本地几何占位，不加载远程模型，也不触发任何付费模型调用。

## 许可证证据

- 上游仓库的许可证文件为 Apache License 2.0，依赖包 `frontweb/node_modules/threepipe/package.json` 声明 `Apache-2.0`。
- 上游 `NOTICE` 文件要求保留版权与许可证告知；发布构建时必须把 Threepipe 的 `LICENSE`/`NOTICE` 纳入第三方声明页或发行包。
- Threepipe 主包及本轮使用的官方核心插件均未发现 GPL 依赖；`@threepipe/plugin-svg-renderer` 为 GPLv3，本项目不安装、不引用。
- Apache-2.0 允许商用，但不等于免除商标、专利、第三方资产和模型服务条款审查；正式收费上线仍需保留归因并完成法务复核。

## 明确排除

- [Wonder Unit Storyboarder](https://wonderunit.com/storyboarder/)：项目使用 “MIT with exceptions”，包含不得对 Storyboarder 收费等例外，不适合作为公开收费平台底座，除非取得书面许可。
- [DirectorsConsole](https://github.com/NickPittas/DirectorsConsole)：仓库声明 proprietary / all rights reserved，不接入。
- [Story2Board](https://github.com/DavidDinkevich/Story2Board)：虽为 MIT，但主要是模型/脚本生成项目，不提供本项目需要的可直接复用 3D 导演台，并会引入额外模型运行和维护面，不纳入当前最小整合范围。

## 发布前清单

1. 在公开收费平台的第三方声明页保留 Threepipe 的许可证和 NOTICE。
2. 锁定 `threepipe@0.5.1` 与 lockfile，升级前重新审计依赖许可证和安全公告。
3. 不使用 GPLv3 的 Threepipe 扩展；如未来需要扩展，先单独完成许可证批准。
4. 角色/场景/道具真实模型、字体、贴图和模型服务分别完成来源与商用权确认。
5. 继续保持“无付费模型测试”的验收边界；模型供应商只在运营配置和真实用户请求链路中按计费策略执行。
