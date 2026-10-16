# M2 收尾与版本化决策草稿设计

> 后续进度：M3 已交付本地模拟审批处理、版本失效与审计，见 [审批验收](M3-approval-acceptance.md)。本文保留当时阶段的设计与验证边界；执行器仍未接入。

范围：桌面调查通过独立MCP stdio读取冻结证据与Skill；JSON/Markdown报告含运行ID、证据索引、完整快照与过程；决策草稿可修订并请求本地模拟审批。沿用原桌面主题和导航。审批处理与业务写入不在本轮。

## 契约与范围

- 模型仅请求四个空参数只读工具。主进程从注册窗口解析Workspace，向固定Bun子服务传递Workspace与run ID；不接受renderer路径、命令或SQL。服务只读加载该run的冻结证据，主进程逐次检查证据ID、hash、批次、规则和店铺/渠道/SKU。连接失败无进程内降级。所有桌面调查工具trace标记mcp_stdio，Reviewer不持有工具端口。
- 导出请求仅含run ID及md/json格式；服务构造文件名和内容。JSON保存原始数据，Markdown把业务/模型文案作为文本转义，并使用足够长的代码围栏包裹原始JSON。
- 新IPC：decisions、decision_create、decision_revise、decision_submit、decision_history、investigation_export。创建/修改只接受调查ID、方案类型、备注与期望版本；不接受金额、数量、通过状态、actor或业务范围。参数由确定性领域测算重建。

## 数据与事务

每Workspace现有investigations数据库追加版本1决策表：decisions当前头、decision_versions不可变版本、decision_requests不可变待审批申请、decision_events审计事件。id主键、run唯一、(decision,version)唯一、请求同版本唯一。建立新版本使旧版本和旧申请展示为superseded，旧参数与事件保留。当前版本带policy、报告/证据摘要、前后值、备选方案、假设约束、30分钟有效期与action hash。

提交时IMMEDIATE事务同时锁定调查库与ATTACH的两类源库，在锁内核对当前版本、证据、规则、报告复核与摘要，再写入待审批申请及事件；源库不写业务值。重复提交相同版本不重复建申请；旧版本写入拒绝。此处只对本地SQLite事务负责，不声称外部系统原子性。

## 提交门禁

- 草稿可以来自离线演示、待补证报告，便于记录；提交必须是实际模型Reviewer通过且所选方案硬约束通过。
- 只允许demo源进入明确标注的模拟待审批；CSV仅能保存分析草稿。演示证据导入不超过24小时，草稿不超过30分钟，时间异常阻断。固定历史演示业务日期不代表实时数据，这项例外只用于本地模拟，不能用于真实业务批准。
- 观察方案不需动作审批；缺字段、不可行库存方案、被替换快照、规则/质量/计算变化及版本冲突阻断。广告条件花费值不等于平台真实预算，当前仅为模拟参考值。
- P0 actor固定local-analyst，来自服务，不接受用户/模型伪造；不声称有独立审批人身份保证。没有approve、execute或其他业务写接口。申请包含版本、hash、policy和过期时间，留给后续M3审批器再校验。

## 验收

领域覆盖幂等创建/提交、并发版本冲突、旧申请失效、缺证/过期/跨场景/替换快照阻断、重启历史与导出文本安全；MCP实际stdio覆盖导入修正后run仍返回旧证据，额外参数/跨范围/写请求拒绝；原生Electron覆盖三场景MCP trace、导出下载、创建/修订/提交、历史与重启。

历史Case、AgentBackend重用、暂停续查、审批处理、执行与对账、真实系统权限和48+业务评测仍待后续阶段，不将本轮称为完整PRD完成。
