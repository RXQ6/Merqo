# M2 三场景调查验证记录

日期：2026-10-16。交付范围是三场景只读调查核心、独立 MCP 和可复用 Skill；完整经营执行闭环尚未完成。

## 工程验证

| 检查 | 实际结果 / 本机证据 |
| --- | --- |
| 领域计算、导入、SQLite、调查及边界 | 60项通过、0失败；领域类型通过，`artifacts/m2-domain-check.log` |
| MCP 实际 stdio | 三场景各四个工具、只读声明、空参契约、跨范围与执行请求拒绝、Skill资源、启动证据冻结通过；`artifacts/m2/mcp-check.json` |
| 全项目类型 | 通过；最终主进程修改另经 Electron 类型复检，`artifacts/m2-all-types.log`、`artifacts/m2-final-electron-types.log` |
| 传输契约 | 2项通过，`artifacts/m2-transport.log` |
| 开发构建 | 完整构建通过，保留上游大包提示；最终主进程与资源另行构建，`artifacts/m2-three-build.log`、`artifacts/m2-final-main-build.log` |
| 原生 Electron | 首次流程与重启两阶段通过；`artifacts/m1/e2e-initial.json`、`artifacts/m1/e2e-restart.json` |
| 视觉检查 | 已检查原桌面调查页截图；新增 `artifacts/m1/investigation-inventory.png` 与 `investigation-ads.png` |

原生流程经过 React、preload、主进程、Bun Worker 和 SQLite，检查三场景调查入口、每次两种方案、18次本地HTTP调用（各五次模型决策加一次Reviewer）、未暴露原生工具、DeepSeek结构化请求关闭隐式思考、明确的离线标识、跨重启三场景历史保留，以及原有导入隔离/幂等/修正回归。本地HTTP契约服务不代表真实模型推理。

## 真实模型小样本

用已有安全凭据连接调用 **deepseek-v4-flash**。只发送内置 TEA-500 合成案例，不使用用户真实经营数据。验收使用与桌面相同的推理适配器、领域核心和版本化 Skill；真实模型部分未通过桌面点击运行，桌面调用链由上述隔离协议测试覆盖。

| 场景 | 调用次数 | 格式纠正 | 耗时 | 实际结果 |
| --- | --- | --- | --- | --- |
| 促销毛利 | 7 | 1 | 13.277秒 | 有引用报告、两种条件方案、Reviewer passed |
| 缺货风险 | 7 | 1 | 15.062秒 | 有引用报告、两种方案、Reviewer passed；补货草稿仍因到货前缺口被代码阻断 |
| 广告回报 | 6 | 0 | 11.054秒 | 有引用报告、两种条件方案、Reviewer passed；ROAS保持1.8，不承诺降低预算改善回报 |

可核验报告见 [合成案例结果](verification/M2-live-synthetic-2026-10-16.json)。人工核对三份摘要、数值、引用、未知项及复核意见，未将假设当作已证实因果；方案值由代码提供。该小样本不证明真实经营效果、长期输出稳定性或PRD完整评测通过。

首轮确实失败：发生过多JSON对象、额外scope、数组形状不符与默认思考耗尽正文预算。修复为每轮单个工具请求、显式输出契约、最多两次有界格式纠正，以及遵循本地SDK的DeepSeek关闭思考参数。拒绝的请求没有执行工具，也没有自动改为离线结果；此前失败未计为通过。

领域回归覆盖：缺字段阻断、迟到在途、覆盖2天但交期5天、预算条件值90000分/162000分且ROAS不变、引用伪造、跨场景工具、参数越权、错误方案类型、Reviewer驳回、预算终止、只读连接拒绝导入、冻结历史和旧毛利调查兼容。格式纠正计入12次决策上限，最多纠正2次，失败输入绝不扩权。

## 剩余差距

尚未交付历史Case检索、领域AgentBackend复用、桌面通过MCP传输调用独立Server、独立证据文件导出、暂停续查、自动续跑。审批、模拟写入、对账与补偿属于后续M3；48+业务样例、完整真实模型评测门禁和安装包属于后续M5。不能把本轮写成整个PRD已完成。

操作路径及MCP启动方法见 [三场景调查验收](M2-investigation.md)。
