# Windows 桌面预览版

版本：`0.1.0-beta.1`。Windows x64，测试主机为 Windows 11。此发布提供安装包，不代表 M5 全部门禁通过。

## 下载与运行

- [Windows x64 安装包](https://github.com/RXQ6/Merqo/releases/download/v0.1.0-beta.1/Merqo-Setup-0.1.0-beta.1-x64.exe)
- [SHA-256 校验文件](https://github.com/RXQ6/Merqo/releases/download/v0.1.0-beta.1/SHA256SUMS.txt)
- [发布说明](https://github.com/RXQ6/Merqo/releases/tag/v0.1.0-beta.1)

下载后运行安装向导，选择安装目录。经营分析所需的 Bun、数据工作进程、MCP 和三个场景 Skill 已内置，无需安装 Node.js 或 Bun。通用 Agent 的 Shell 功能仍需 Git for Windows；未安装时可点击“仅使用经营分析”，有 Git Bash 时也可在模型选择页点击“稍后设置”。

启动后点击“经营分析”，进入“数据与导入”载入演示数据，再查看“经营总览”“异常中心”“库存与广告”。“返回会话”在同一窗口切回会话。基础规则与离线演示无需 API Key；真实模型调查仍需在设置中配置自己的兼容模型连接。

安装包没有代码签名证书，Windows 可能显示未知发布者或 SmartScreen 提示。请核对下载来源和 SHA-256；本预览没有自动更新服务，后续版本通过 Releases 下载。

```powershell
Get-FileHash .\Merqo-Setup-0.1.0-beta.1-x64.exe -Algorithm SHA256
```

普通安装数据保存在用户目录下的 `.retailpilot`，Chromium 状态使用 `%APPDATA%\RetailPilot`，不写入程序目录。开发启动的 `.runtime` 数据不自动迁入安装版。卸载保留用户数据；清理或迁移数据前应另行备份。

## 打包和开发验证

在 Windows x64 开发主机安装源码依赖后运行：

```powershell
bun run retail:dist:win
```

脚本使用 `packaging/windows-release.json` 固定应用、Electron 和 Bun 版本。Bun 使用官方 baseline x64 二进制并核对官方 SHA-256。只从明确列出的源码构建产物与依赖暂存，不复制 `.runtime`、用户配置或凭据；存在 `.env` 时拒绝公开打包。产物位于 `artifacts/windows/0.1.0-beta.1/`，同时生成 `SHA256SUMS.txt`。下载依赖时可在当前终端配置 `HTTPS_PROXY`，无需更改系统或 Git 配置。

`scripts/merqo-packaged-smoke.cjs` 使用 Playwright 的 Electron 支持测试真实打包可执行文件。开发主机须提供 Playwright，可通过 `MERQO_PLAYWRIGHT_MODULE` 指定模块路径。`scripts/merqo-installer-check.cjs` 对 NSIS 执行隔离安装、打包程序验收、同版本重装、持久化验证和卸载。

## 发布范围

这是本地分析和模拟执行预览，不接入真实 ERP、广告或改价系统。模型传输和 MCP 安装验证使用本地 HTTP 协议夹具，不构成真实模型推理质量证据。固定业务评测仍有 12 个未支持样例；三场景各五次真实模型评测、十万行查询性能、跨版本升级和干净 Windows 虚拟机兼容性尚未完成。下载包可用与全部 PRD 发布门禁通过分开记录。
