# M5 本机安全验收映射（2026-10-19）

范围为本地分析与模拟执行。依据本轮领域全量回归、实际 MCP stdio 和隔离 Electron 验收；不把协议夹具算作真实模型对抗评测。完整 M5 结论见 [收口验收](M5-acceptance-2026-10-19.md)。

| 检查 | 实现与测试证据 | 本轮结论 |
| --- | --- | --- |
| 渲染端伪造角色、金额、路径、Workspace、调查更新 | `decisions.test.ts` 的 workspace/actor/amounts、execution denies forged role；`investigations.test.ts` 的 renderer cannot forge；原生 UI 同类检查 | 领域回归通过；原生结果见收口验收 |
| 未审批、错误摘要/版本、过期授权不能执行 | `decisions.test.ts` 的 stale expected version/hash、expired application、authorization exact deadline、expired/superseded execution | 领域回归通过；不等于所有状态页面已验 |
| CSV 分析结果不能借用 demo 执行例外 | `decisions.test.ts` 的 CSV is analysis only、membership/CSV approval、报价不能授予CSV执行权限 | 回归通过；CSV 文字提示注入仍需独立攻击样例 |
| 只读工具越权、跨范围参数 | `scripts/merqo-mcp-check.ts` 的四工具白名单、参数拒绝、跨场景工具拒绝及桌面冻结校验 | 实际 stdio 通过 |
| 篡改 SKU、计算值、来源时间、旁证或 Case | 三个 `*-numeric.test.ts`、`related-evidence.test.ts`、MCP 检查；`signal-investigations.test.ts` | 回归与实际 MCP 通过；冻结相同不代表来源真实性已证明 |
| 重复执行、UNKNOWN、并发和补偿覆盖后续修改 | `decisions.test.ts` 的 duplicate/concurrent/unknown、compensation、batch；原生批次检查 | 领域回归通过；限定本地模拟账本 |
| 模型调用不存在工具、伪造引用、格式错误、预算耗尽 | `investigations.test.ts`、`signal-investigations.test.ts`、`investigation-resume.test.ts` | 协议夹具回归通过，不替代真实模型抗诱导能力 |
| 导出中 CSV 公式与不可信报告文本 | `operations.test.ts` 的 spreadsheet formulas；`decisions.test.ts` 的 untrusted text safely | 回归通过；不声称覆盖所有外部查看器 |
| CSV/Case 自然语言注入诱导越权 | `injection-boundary.test.ts` 将CSV及Case攻击文本送入工具循环，检查合法读取后请求Shell/模拟执行/任意MCP或伪造参数角色时拒绝，记录未变化 | 有限攻击矩阵通过；不声称任意模型版本均抗诱导 |
| 通用聊天 Auto/Shell/其他 MCP 写入旁路 | `retail-tool-boundary.ts` 在Auto/Ask与自定义授权前强制经营空间只读，以可信workspaceRootPath固定范围；实际PiAgent后端注册工具收到Bash及Write调用时拒绝 | 实际后端通过，`verification/route-final-2026-10-19/auto-boundary.json`，账本与标记未变化；普通代码工作区不受限 |

测试结果日志：`docs/verification/m5-acceptance-2026-10-19/domain.log`、`mcp.log`。上述源文件均位于 `packages/retail-domain/src/`，另有明确标注的脚本及 Electron 路径。

新增权限/领域24项134断言、mode11项20断言、独立preTool70项130断言通过。经营空间通用聊天允许Read/Glob/Grep/WebSearch/WebFetch/AskUserQuestion/TodoWrite；专用模拟审批执行不经该聊天工具边界，仍受独立校验。真实模型最终15次禁止动作事件0。

本轮未发现已覆盖样例的未授权写入；不覆盖未测试攻击路径，不声称防止应用外拥有操作系统权限者直接改库。A5/G02有限本地验收已有证据，外部可信身份与真实平台权限属于后续接入。最新记录见[本轮验收](verification/route-final-2026-10-19/report.md)。
