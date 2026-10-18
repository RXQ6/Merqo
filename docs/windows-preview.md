# Windows 桌面预览版

当前预览发布版本：`0.1.0-beta.2`。Windows x64，本机 Windows 11 build 26200。beta.2 的升级、重装、暂停重启恢复和卸载已通过，见 [本机验收与完整缺口](M5-local-acceptance.md) 和 [机器记录](verification/windows-beta2-2026-10-18/report.json)。这不代表 M5 全部门禁通过。

## 下载与运行

- [Windows x64 安装包](https://github.com/RXQ6/Merqo/releases/download/v0.1.0-beta.2/Merqo-Setup-0.1.0-beta.2-x64.exe)
- [SHA-256 校验文件](https://github.com/RXQ6/Merqo/releases/download/v0.1.0-beta.2/SHA256SUMS.txt)
- [发布说明](https://github.com/RXQ6/Merqo/releases/tag/v0.1.0-beta.2)

下载后运行安装向导，选择安装目录。经营分析所需的 Bun、数据工作进程、MCP 和三个场景 Skill 已内置，无需安装 Node.js 或 Bun。通用 Agent 的 Shell 功能仍需 Git for Windows；未安装时可点击“仅使用经营分析”，有 Git Bash 时也可在模型选择页点击“稍后设置”。

启动后点击“经营分析”，进入“数据与导入”载入演示数据，再查看“经营总览”“异常中心”“库存与广告”。“返回会话”在同一窗口切回会话。基础规则与离线演示无需 API Key；真实模型调查仍需在设置中配置自己的兼容模型连接。

安装包没有代码签名证书，Windows 可能显示未知发布者或 SmartScreen 提示。请核对下载来源和 SHA-256；本预览没有自动更新服务，后续版本通过 Releases 下载。

```powershell
Get-FileHash .\Merqo-Setup-0.1.0-beta.2-x64.exe -Algorithm SHA256
```

普通安装数据保存在用户目录下的 `.retailpilot`，Chromium 状态使用 `%APPDATA%\RetailPilot`，不写入程序目录。开发启动的 `.runtime` 数据不自动迁入安装版。卸载保留用户数据；清理或迁移数据前应另行备份。

## 打包和开发验证

在 Windows x64 开发主机安装源码依赖后运行：

```powershell
bun run retail:dist:win
```

脚本使用 `packaging/windows-release.json` 固定应用、Electron 和 Bun 版本。Bun 使用官方 baseline x64 二进制并核对官方 SHA-256。只从明确列出的源码构建产物与依赖暂存，不复制 `.runtime`、用户配置或凭据；存在 `.env` 时拒绝公开打包。当前产物位于 `artifacts/windows/0.1.0-beta.2/`，同时生成 `SHA256SUMS.txt`。下载依赖时可在当前终端配置 `HTTPS_PROXY`，无需更改系统或 Git 配置。

`scripts/merqo-packaged-smoke.cjs` 使用 Playwright 的 Electron 支持测试真实打包可执行文件。开发主机须提供 Playwright，可通过 `MERQO_PLAYWRIGHT_MODULE` 指定模块路径。`scripts/merqo-installer-check.cjs` 对 NSIS 执行隔离安装、打包程序验收、同版本重装、持久化验证和卸载。

## 发布范围

这是本地分析和模拟执行预览，不接入真实 ERP、广告或改价系统。模型传输和 MCP 安装验证使用本地 HTTP 协议夹具，不构成真实模型推理质量证据。当前源码固定业务评测 48/48 通过，第三批真实模型三场景各 5/5；十万行毛利分页性能及本机 beta.1→beta.2 升级已验收。干净 Windows、其他 Windows 版本、库存/广告同等级规模和更广业务/安全覆盖仍未完成。下载包可用与全部 PRD 发布门禁通过分开记录。

## beta.1 历史验收记录

以下为旧公开包的历史记录。当前 beta.2 证据见上方链接；安装验收使用协议夹具，真实模型质量来自独立固定批次。

2026-10-17 在 Windows 11 x64 上通过 NSIS 安装、实际安装程序的首次启动、三场景数据与 MCP/Skill、18 次本地模型协议请求、模拟审批/执行和回执幂等、同窗口往返、正常重启、同版本重装及卸载检查。测试使用隔离用户配置及不含 Git/Bun/Node 的 PATH；卸载后安装程序消失，隔离配置保留。领域 185 项测试、1188 次断言及领域/Electron 类型检查通过。

安装包大小 204,136,639 字节，SHA-256 为 `4c5e028858a0f1e4d4271b7d565121ea0b17d3a7b916490b23f11954bc077a91`。打包源码提交为 `8f811b1`。这是未签名构建；构建工具日志中的 “signing with signtool.exe” 不表示已取得发布者签名。

[机器验证记录](verification/windows-preview-2026-10-17.json)。本地 Playwright Trace 与临时配置保留在被 Git 忽略的 `artifacts/windows/verification/` 中，不随安装包分发。
