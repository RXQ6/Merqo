# M0 工程基线验收记录

日期：2026-10-15。范围：独立项目、开发构建、启动与存储兼容性。此记录不表示电商经营 Agent 已完成。

## 已交付

- 从用户指定的 Craft Agents 0.11.4 源码快照创建独立 `retailpilot-agent`，保留许可证、原始归属与上游说明。
- Git 基线提交 `64a2067`，记录 1,877 个源文件的 SHA-256；最终核验原始文件全部匹配。
- Windows 产品名 RetailPilot、独立 appId `local.retailpilot.agent`、深链接 `retailpilot://`、SVG/PNG/ICO 与界面品牌组件。
- 配置、Workspace、凭据、文档、缓存与日志的默认目录迁移到 RetailPilot；开发启动器使用项目内 `.runtime/`。
- 禁用未配置的更新、分享上传、错误上报、隐式上游文档 MCP 和上游 OAuth Relay。
- 新增 `@retailpilot/domain`：SKU、销售、库存、促销、证据、动作、方案、审批与执行记录的初版可执行契约。
- SQLite 子进程兼容性探针及 Node/Electron 宿主验证脚本。
- 启动说明、领域契约说明、可复现隐藏桌面冒烟脚本。

## 验证结果与证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 上游源码完整性 | 1,877 个文件 SHA-256 一致 | `node scripts/retailpilot-verify-baseline.cjs`，`docs/baseline/upstream-manifest.json` |
| 桌面完整开发构建 | 通过 | 根目录 `artifacts-m0-build.log` |
| 非标准 Git 安装检测修复后的主进程构建 | 通过 | `artifacts-m0-main-rebuild.log` |
| 领域契约与权限、路由等回归 | 84 通过，0 失败 | `artifacts-m0-tests.log`，其中领域契约 5 项 |
| Git Bash 检测与路径校验 | 6 通过，0 失败 | `bun test apps/electron/src/main/__tests__/git-bash.test.ts` |
| Node → Bun SQLite | 通过 | `node scripts/retailpilot-persistence-host.cjs` |
| Electron Node → Bun SQLite | 通过 | Electron 39.2.7 的 Node 22.21.1 宿主执行同一探针 |
| SQLite 行为 | 迁移版本、事务回滚、唯一幂等键、外键、关闭重开均通过 | `scripts/retailpilot-sqlite-probe.ts` |
| 初次实际桌面启动 | 页面、preload、本地 API 连通，未发现 preload 异常 | `artifacts/m0/desktop-process.log` |
| 最终桌面与目录隔离 | 通过：`ok=true`、`isolated=true`、`gitBash.found=true`；识别 `D:/Git/bin/bash.exe`，页面为 RetailPilot 欢迎页 | `artifacts/m0/desktop-smoke.json`、`desktop-smoke.png` |
| 全项目类型检查 | 通过，退出码 0；最终 RPC 接入改动另经 server-core 类型检查通过 | `artifacts-m0-typecheck.log` |

日志和截图是本机生成产物，受 `.gitignore` 排除，不包含在源码提交中。验证环境：Windows，Bun 1.4.2、Node 24.15.0、Electron 39.2.7。

## 实际发现并处理的问题

1. `bun install --frozen-lockfile` 首次在沙箱临时目录报 EPERM；授权安装后，Electron GitHub 下载超时。通过显式镜像运行 Electron 安装脚本补齐运行时；镜像仅用于下载，没有写入全局配置。
2. 快照缺少 `tsconfig.base.json`，导致部分包类型检查失败。补齐基础配置，并修复由严格索引检查暴露的测试、URL 捕获组、字符串分割与工具预取访问问题；没有关闭新增领域包的严格模式。
3. 测试未初始化 Windows PowerShell 校验器，修复测试启动设置，保留实际权限断言。
4. 只改全局 CONFIG_DIR 不足以隔离全部数据：文档、凭据、Workspace 与日志存在独立路径。已使这些路径遵循所选 RetailPilot 配置目录。
5. Git 安装在 `D:/Git`，上游只找常见目录或 PATH 中第一个 Bash，误报缺失。新增从 PATH 中 Git 可执行文件位置推导其 Bash 路径，避免将 System32 的 WSL Bash 误判为 Git Bash。
6. 上游快照没有提供 `.husky/pre-commit` 等项目 Hook，依赖安装却通过 `prepare: husky` 注册了空包装器，提交时包装器查找 `sh` 失败。移除这条无对应 Hook 的初始化配置，并清除本地生成的 `core.hooksPath`；没有跳过任何项目 Hook 检查，验证命令已独立执行。

## 边界与待办

- 当前仍是通用 Agent 工作台基础界面；经营总览、导入、调查、Reviewer、业务审批、执行账本和 Case Memory 未实现。
- 实际模型连接、SDK 工具调用与会话恢复未进行端到端验收，原因是本阶段未配置模型凭据；没有读取或迁移用户原有凭据。
- SQLite 验证是开发环境探针，不是业务库或已集成服务；安装包内 Bun 路径、迁移备份与正式工作进程协议仍需后续验证。
- 完整构建保留 Vite 大文件体积警告；未做代码分包优化。本阶段未生成或验收 Windows 安装包。
- 上游 preload 使用 Node 依赖，窗口保留原有 `sandbox: false`；开发构建仍提示 CSP 安全警告。已有 `contextIsolation: true`、`nodeIntegration: false`，但不能据此宣称完成桌面安全加固。发布前需专项处理 preload 进程边界和 CSP。
- 非 Windows 品牌资源、签名、公证与打包不在本次验收范围。
- 真实业务写 Adapter 尚未接入，当前不能把通用 Auto 模式当作经营审批。
- 未设置远程 Git 地址，未推送、创建 PR 或发布。

## 下一阶段入口

### 欢迎页显示问题修复补记

用户反馈正常启动看不到欢迎页后，修正 `retail:start` 对 GUI 进程使用隐藏启动参数的问题，清除继承的测试隐藏标记，并在首次显示时恢复、显示和聚焦窗口。窗口位置状态也改为遵循 `CRAFT_CONFIG_DIR`。

之前的隐藏截图检查未覆盖窗口是否可见，不能作为可见性证明。新增 `--visible` 检查会记录当时的 `visible/minimized`；窗口被最小化时该严格检查会失败，即使页面已成功加载。本次用户已确认能看到欢迎页，随后通过正式 `bun run retail:start` 打开并保留窗口。正式启动日志于 2026-10-15 17:20（Asia/Shanghai）记录 `Workspace window shown`、`visible=true`、`minimized=false`，并确认本地服务已连接。主进程已重新构建通过。

M1：完成合成数据与 CSV 导入、指标计算、规则版本、异常对象和正式持久化边界。第一条垂直切片为“促销侵蚀毛利”，先做可复现的确定性计算与证据，再接 Agent 调查。审批和实际写入仍按 PRD 安排在 M3。
