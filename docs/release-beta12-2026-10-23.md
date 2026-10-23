# Merqo beta.12 发布记录

日期：2026-10-23，Windows x64 预览版。

本轮路线已完成：beta.11推送、合并与发布 → 本机旧版升级验收 → 可编辑AI晨会 → 商品/案例分类 → 可解释案例匹配 → 可关闭的反馈排序 → beta.12打包回归。

- [新增功能及软件入口](experience-enhancement-2026-10-23.md)。
- [验收报告及截图](verification/enhancement-2026-10-23/report.md)：414项领域测试、3759次断言；25组打包流程；12项边界回归、113次断言；MCP实际stdio边界检查通过。
- [NSIS安装生命周期结果](verification/enhancement-2026-10-23/nsis-upgrade-result.json)：实际安装beta.11并创建证据/调查/任务/案例 → 升级beta.12保留相同记录并生成schema12备份 → 新增商品品类 → 同版重装保留旧记录及新增品类 → 卸载保留独立工作区。原有快捷方式保留，不使用用户工作区。
- 应用构建源码：`9c1fcf6954119589e0c90f0deb8b215a86bf283d`，构建时工作区干净；后续验收脚本、截图和文档提交不改变应用内容。
- 安装包：204393416字节。
- SHA-256：`2d6eaf7b98c02666522e9bd56ef6f44a75b911589175e902e8c4369ebed45856`。
- 数据库schema13，首次升级自动保留迁移前备份。不要使用beta.11或更旧版本直接打开升级后的工作区。

真实模型的业务质量、真实平台授权、干净与跨Windows环境仍需外部验收。审批/执行保持本地模拟。抖店和安卓按约定排除在本轮之外。安装包未签名。

[GitHub发布](https://github.com/RXQ6/Merqo/releases/tag/v0.1.0-beta.12) · [PR #4](https://github.com/RXQ6/Merqo/pull/4)
