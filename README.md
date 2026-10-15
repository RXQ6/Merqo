# RetailPilot 经营决策 Agent

将电商与零售经营数据组织成可追溯、可审批的决策流程。

**当前交付：M1 数据与规则 + M2 首个促销毛利调查切片。** 使用原桌面工作台，从“经营分析”进入数据与调查。支持 CSV 导入、毛利预警、证据查看，以及“开始调查”、四个只读工具、带引用的报告、两种方案测算、串行 Reviewer 和持久化调查记录。模型调查需受支持的 API 连接；离线规则演示单独标注。业务审批、执行及另外两个场景尚未实现。

先按 `docs/M1-acceptance.md` 验收。演示数据应有 6 条快照、2 条毛利预警、2 条待补证，完整证据部分的商品收入 ¥7,125.00、商品毛利 ¥1,765.00。

调查验收见 [M2 操作与边界](docs/M2-investigation.md)：找到 `TEA-500`，点击“查看”旁的“开始调查”。未配置受支持模型时明确失败，可另选“运行离线规则演示”。支持 Anthropic Messages / OpenAI Chat Completions 兼容 API Key 或本地模型；订阅 OAuth 与云身份连接暂不支持。

## 在 Windows 启动

要求：Bun 1.4.2、Node 24，首次安装需要网络。验证使用 Electron 39.2.7。

```powershell
cd D:\helson-skills\craft-agents-oss-main\retailpilot-agent
bun install --frozen-lockfile
bun run retail:build
bun run retail:start
```

当前机器已安装依赖并生成开发构建。可直接执行 `bun run retail:start`。

若 Electron 下载失败，可在同一个 PowerShell 会话中重试：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
node node_modules/electron/install.js
```

`retail:start` 使用项目目录内 `.runtime/config` 与 `.runtime/chromium`，不复用原 Craft 配置或凭据。直接启动 Electron 的默认配置目录为用户目录下 `.retailpilot`，Chromium 数据目录为系统 AppData 中的 `RetailPilot`。`CRAFT_CONFIG_DIR` 保留为兼容环境变量，可覆盖配置路径；内部 `@craft-agent/*` 包名和版本暂时保留，避免破坏基座协议与依赖。

启动后使用原有桌面工作台。首次模型连接页选择“稍后设置”即可进入；从原侧栏“经营分析”打开经营总览，再点击“载入演示数据”。经营分析沿用桌面主题与面板，点击“返回会话”或其他侧栏入口可切回原工作台。M1 经营计算不调用模型，不需要模型凭据。

## 验证

```powershell
bun run retail:check
bun run typecheck:all
node scripts/retailpilot-persistence-host.cjs
node scripts/retailpilot-m1-e2e.cjs
node scripts/retailpilot-run-desktop-smoke.cjs
bun run retail:verify-baseline
```

桌面冒烟使用隐藏窗口与专用 `.runtime/smoke-v2` 目录，输出到 `artifacts/m0/`，自动退出。该检查只证明欢迎页、本地 API 与服务连接，不能替代模型调用和经营流程验收。

验证窗口实际可见时执行 `node scripts/retailpilot-run-desktop-smoke.cjs --visible`。这会短暂显示窗口并自动退出；结果需同时满足 `visible: true` 和 `minimized: false`。正常使用运行 `bun run retail:start`，窗口会保留。

## 默认服务策略

- 禁用尚未配置的更新服务、上游分享上传、Sentry 上报和隐式上游文档 MCP。
- 依赖上游 OAuth Relay 的连接被明确阻断；自带 API Key、直接回调与模型供应商自己的认证流程继续保留。
- 上游技术文档链接与官方 Craft Source 的品牌属于来源或外部服务描述，不能理解为本产品的所属关系。
- 首发仅覆盖 Windows。macOS 的 ICNS、Assets.car 与 DMG 资源尚未改造，不发布其他平台安装包。
- 尚未实现只读经营会话的工具裁剪和业务权限引擎。当前通用 Agent 的 Auto 权限不等于获得任何真实经营写权限。

## 文档与来源

- `docs/domain-contracts.md`：数据与持久化边界。
- `docs/M1-acceptance.md`：手工与自动验收步骤、样例和预期结果。
- `docs/M1-design.md`：场景架构、计算口径和范围边界。
- `docs/M0-acceptance.md`：实际验证、已知限制与下一阶段入口。
- `docs/baseline/upstream-manifest.json`：1,877 个原始文件的 SHA-256。
- `docs/upstream-README.md`：原项目说明。
- `LICENSE`、`NOTICE`、`TRADEMARK.md`：保留的上游许可、归属与品牌政策。

技术基座来源：用户提供的 Craft Agents 0.11.4 本地源码快照。新项目没有设置 Git 远程地址，也没有推送或发布。
