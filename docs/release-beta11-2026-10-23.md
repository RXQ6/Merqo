# Merqo beta.11 发布记录

日期：2026-10-23。版本 v0.1.0-beta.11，Windows x64 预览。

- UI、Wiki 和晨会/商品档案/案例复用范围见 [S0—S4](experience-S0-S4-2026-10-23.md)。
- 409项领域回归、20组打包流程通过，见[验收报告](verification/experience-2026-10-23/report.md)。
- 实际 beta.8 安装→生成经营证据、任务及案例→NSIS 升级 beta.11→保留相同记录并生成 schema10 备份→同版重装→卸载保留测试工作区，四组通过：[结果](verification/experience-2026-10-23/nsis-upgrade-result.json)。使用独立短临时目录，原快捷方式保留，未操作用户工作区。
- 首轮启动等待定位失败、一次旧安装器 0xc0000005 均保留失败记录；短路径完整重跑通过，未断言根因已解决或所有路径均兼容。
- 安装包 204387472字节；SHA-256：40ac432b8f6f04efc0334bafdebfea1f09868f596bea1e4d012d9e602e29c539。构建源码 a152596，干净构建；后续文档与 CI 检查修改不改变安装内容。
- schema12升级前自动备份，升级后使用beta.11及更高版本。
- 未签名；当前Windows11本机范围，干净/跨Windows、真实飞书授权和真实平台写入不包含在本次发布验收中。

[GitHub发布](https://github.com/RXQ6/Merqo/releases/tag/v0.1.0-beta.11)
