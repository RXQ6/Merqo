# Merqo beta.13 发布验收记录

日期：2026-10-24，Windows x64 预览版。

新增路线：采购应付与付款 → 退款及复查 → 审核到货入库 → 条码/库位定位 → 多订单波次 → 已付款订单关联发货 → 本地回读 → 调查、任务及案例证据衔接。

- [功能入口、业务范围与截图](local-business-closure-2026-10-24.md)。
- 425项领域测试、3833次断言、62个文件及类型检查通过。
- 打包版已通过：[8组新增业务闭环](verification/local-business-2026-10-24/packaged-local-closure.json)、[5组晨会增强](verification/local-business-2026-10-24/packaged-enhancement.json)、[4组三批链路](verification/local-business-2026-10-24/packaged-three-batches.json)、[8组Wiki](verification/local-business-2026-10-24/packaged-wiki.json)、[8组经营体验兼容性](verification/local-business-2026-10-24/packaged-experience.json)，共33组。
- 应用源码提交：`0c8a7f53ecf96111317afa63afba0e5000c59511`。打包记录中的非干净状态仅为当时未提交的 `scripts/merqo-beta13-upgrade-check.cjs` 验收脚本；该脚本未进入安装包，后续提交为 `d53400e`。应用代码与构建输入未因此变化。
- 安装包：`Merqo-Setup-0.1.0-beta.13-x64.exe`，204408504字节。
- SHA-256：`e5189071c8b60c356346d2ff2d87e740c5633cdf83e3970fb40e8b1627394848`。
- 数据库沿用schema13，新台账及索引为增量创建。beta.12→beta.13不重新触发schema12迁移备份，不应将缺少新迁移备份视为升级失败。

[实际NSIS安装生命周期](verification/local-business-2026-10-24/nsis-upgrade-result.json)四组通过：安装beta.12并生成旧记录 → 升级beta.13保留相同调查/任务/案例 → 同版重装保留记录及商品分类 → 卸载保留隔离数据。原快捷方式已恢复。安装包未签名，本机Windows 11验收不能替代干净环境及跨Windows版本验证。

真实银行/物流/平台写回、独立身份多人审批及部分换货信用额结转尚未交付。抖店与安卓按约定暂缓。

[GitHub发布](https://github.com/RXQ6/Merqo/releases/tag/v0.1.0-beta.13) · [PR #5](https://github.com/RXQ6/Merqo/pull/5)
