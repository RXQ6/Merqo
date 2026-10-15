# M1 实施与验证记录

2026-10-15，范围为促销毛利场景的数据与规则闭环。

## 已实现

- 原桌面侧栏中的经营分析入口、经营总览、异常中心、数据导入和证据详情；无需模型配置。
- 按日 SKU 快照、UTF-8 CSV 映射与预览、输入约束、重复及错误行隔离、质量报告。
- 商品收入与毛利确定性计算，整数分与精确整数汇总，20% 版本化演示规则，缺证阻断、SKU 规格冲突识别。
- 当前快照、不可变原始行历史、批次、隔离错误、规则定义与批次版本的 SQLite 持久化；schema 版本 2。
- 同文件与映射幂等，SQLite IMMEDIATE 事务内进行查重、容量检查与写入，支持两个独立工作进程同时导入。
- 仅对已注册本机 Workspace 顶层窗口开放的专用 IPC；数据库路径由主进程确定；不接受业务执行命令。
- 证据 JSON、结果 CSV、导入报告导出；CSV 公式前缀转义；演示与用户 CSV 来源分开统计。
- 三份可复现样例与完整手工验收文档。

## 验证

| 检查 | 实际结果 | 本机证据 |
| --- | --- | --- |
| 领域、CSV、SQLite 与并发测试 | 21 通过，0 失败；领域类型检查通过 | `artifacts/m1-domain-check.log` |
| 传输契约测试 | 2 通过，0 失败 | `artifacts/m1-transport-tests.log` |
| 全项目类型检查 | 通过，退出码 0 | `artifacts/m1-all-types.log` |
| 最后 UI 改动后的 Electron 类型检查 | 通过，退出码 0 | `artifacts/m1-electron-types.log` |
| 完整开发构建 | 通过 | `artifacts/m1-build.log` |
| 最终 renderer 构建 | 通过；保留上游大文件体积警告 | `artifacts/m1-renderer.log` |
| Electron 页面端到端 | 首次流程与重启两阶段均通过，两份报告均 `ok: true` | `artifacts/m1/e2e-initial.json`、`e2e-restart.json` |
| 实际截图 | 已检查经营总览与证据抽屉；导入预览另存 | `artifacts/m1/overview.png`、`evidence.png`、`import-preview.png` |
| 原始源码基线 | 1,877 个文件 SHA-256 一致，原项目未修改 | `scripts/retailpilot-verify-baseline.cjs` |

端到端检查经过实际 React 页面、preload、Electron 主进程、独立 Bun 工作进程和 SQLite，不用模拟数据 API 响应代替真实链路。检查演示收入 ¥7,125.00、毛利 ¥1,765.00，4 条异常，TEA-500 的 14.29% 毛利与证据；检查 CSV 部分隔离、重复导入、更正至 33.33%、禁止伪造 Workspace/改价命令，以及真实退出后重新启动仍可恢复。

开发过程中遇到并修复了直接 IPC 方法需显式排除于 WS Channel Map 类型契约、验收脚本异步表达式、测试工作进程路径与隐藏窗口截图等待绘制的问题。构建期间覆盖 renderer 资源会使同时启动的检查读到缺失资源，最终验收在构建完成后顺序执行，不将该中间运行作为产品成功证据。

## 范围边界

未实现 Agent 调查、模型分析、建议草稿、审批与经营动作执行；未接真实 ERP/广告平台；未生成安装包；未提供规则编辑器、历史版本对比 UI 或实时数据同步。导入记录页面显示最近 50 批，数据库保留历史批次。尚未进行 10 万行性能验收，当前每来源限制 10,000 条当前快照。

手工验收见 `docs/M1-acceptance.md`，架构与口径见 `docs/M1-design.md`。通用 Agent 的旧能力不能充当本轮未实现业务能力的证据。

## 桌面界面恢复（2026-10-15）

启动恢复原 App、欢迎及桌面工作台，经营分析嵌入原侧栏和面板。移除独立深蓝导航、宣传标题及悬浮返回按钮。内容继承原字体、明暗主题与语义色；返回会话和原侧栏跳转保留原工作流，SQLite 与业务计算未改变。

本轮验证：Electron 类型检查通过；renderer 构建通过；隔离原生 Electron 测试的 initial / restart 两阶段通过，覆盖原桌面启动、原侧栏经营入口、返回和重入、浅/深主题、CSV 导入隔离与幂等、修正快照、证据和重启持久化。截图位于 artifacts/m1/desktop-shell.png、overview.png、overview-dark.png。测试通过不代表模型调查、审批或执行能力已交付。
