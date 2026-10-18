# RetailPilot 电商与零售经营决策 Agent

PRD 与源码改造计划书 · v0.1 · 2026-10-15

> 本轮交付为计划书。本文中的业务模块、接口、页面和验收指标均为拟建目标，尚未实现或验证。技术基座事实来自指定本地源码；此前的场景简历材料仅用于了解背景，不作为已实现能力的证明。

## 1. 项目定位与总体决策

将通用 Agent 工作台改造为面向电商运营、零售店长与经营负责人的决策工作台，围绕商品和 SKU，联合销售、库存、价格、促销、广告与毛利数据，完成：

**监控 → 发现异常 → 调查归因 → 比较方案 → 人工审批 → 执行处置 → 效果复盘。**

暂定产品名：**RetailPilot 经营决策 Agent**。采用独立项目目录交付，保留 Craft 的 Agent 内核与必要工程能力，新增领域引擎并重做主要产品入口。这里的“改写整个项目”定义为完整的场景产品化改造，包括品牌、导航、数据、工作流、工具权限、持久化、测试、文档与安装包；没有业务必要的 SDK 执行循环、协议与会话机制继续复用。

默认继续使用 TypeScript + Bun + React + Electron。首发 Windows 桌面版，沿用现有服务端分层；WebUI 的经营页面后续补齐。当前没有提出迁移 Python 的业务理由，首版不引入双语言运行时。

### 1.1 场景依据

| 项目 | 内容 |
| --- | --- |
| 场景路由 | `ecommerce-operations`，商业增长与组织行业族 |
| 来源 | `C:/Users/29486/.codex/skills/craft-agents-resume-skill/references/scenario-architecture.md` 第 5 节 |
| 业务范围 | SKU、促销、库存、销售、广告、价格、毛利与权限约束 |
| 权限 | 查询分析自动；改价、调预算、补货、下架、对外通知均需业务审批；删除业务数据默认禁止 |
| Reviewer | 只读复核，允许驳回或要求补证，不持有业务写权限 |
| 评测重点 | SKU 匹配、证据覆盖、误报、约束违反、动作安全 |

### 1.2 本版假设

- 先做单组织经营原型，可管理多个店铺、渠道和仓库；不宣称具备 SaaS 多租户能力。
- 无真实 ERP、BI、广告账户或 API 凭据，首版以合成数据、CSV 导入和模拟业务系统验收。
- 默认币种 CNY，业务时区 Asia/Shanghai；首版拒绝混币种直接汇总，不隐式换汇。
- 模型连接沿用基座配置。离线演示可使用固定工具响应回放；真实 Agent 演示需要有效模型连接。
- 示例规则和财务口径可配置，只作为产品验收样例，不代表适用于所有商家。

## 2. 源码核验与改造边界

源码根目录：`D:/helson-skills/craft-agents-oss-main/craft-agents-oss-main`。

本次读取的根 `package.json` 版本为 `0.11.4`。当前目录为源码快照，未找到 Git 仓库元数据，也未发现适用的 `AGENTS.md`；实施前需记录文件清单与摘要建立基线。本轮未安装依赖、启动程序或运行测试，以下“已有”仅表示已读取相应源码。

下表路径均相对于上述源码根目录。

| 能力 | 核验入口 | 已有事实与改造决定 |
| --- | --- | --- |
| Agent 内核 | `packages/shared/src/agent/base-agent.ts` | 统一后端、权限、Source、Prompt、配置与用量等管理；继续复用 |
| 调用前检查 | `packages/shared/src/agent/core/pre-tool-use.ts` | 存在权限模式、Source、前置条件及输入处理管线；挂接领域策略，但不能仅依靠此处保护写入 |
| 通用权限 | `packages/shared/src/agent/core/permission-manager.ts` | 有集中式工具权限判断；新增不可由 Auto 模式绕过的业务授权 |
| 数据源接入 | `packages/shared/src/sources/server-builder.ts` | Source 配置转 MCP/API 服务；新增经营只读工具接入，不能当作已有 ERP Connector |
| 会话工具 | `packages/session-tools-core/src/context.ts`、`tool-defs.ts` | 共享上下文和工具定义；经营工具用独立领域包维护，必要时增加桥接入口 |
| 计划提交 | `packages/session-tools-core/src/handlers/submit-plan.ts` | 校验计划文件并回调等待用户反馈；不具备领域审批、幂等执行和审批版本校验 |
| 上下文装配 | `packages/shared/src/agent/core/prompt-builder.ts` | 复用装配框架，补充店铺范围、数据时间窗、领域规则与证据索引 |
| 会话持久化 | `packages/shared/src/sessions/types.ts` | 会话 JSONL 与相关字段；业务对象另建事务存储，聊天状态不充当执行账本 |
| 自动化 | `packages/shared/src/automations/automation-system.ts` | 有事件总线、配置、调度服务接入；新增经营任务去重、补跑与故障状态 |
| 服务端 | `packages/server-core/src/handlers/`、`packages/server-core/src/domain/` | 沿用服务与传输层，在领域服务边界加入经营接口 |
| 桌面入口 | `apps/electron/src/renderer/pages/` | 当前含 Chat、Project、Source、Skill 等页面；增加经营导航和专用页面 |
| 品牌打包 | `apps/electron/electron-builder.yml`、`packages/shared/src/branding.ts` | 当前仍有上游产品名、appId 与服务地址，需逐项处理 |

上述入口未证明已经存在完整的电商经营业务模块。本计划将 Adapter、领域 Schema、经营 SOP、审批执行、Case Memory、Reviewer 与行业评测全部登记为新增工作。

Workspace 目录隔离不能当作租户数据权限；会话恢复不能当作业务流程恢复；通用工具批准不能代替业务审批；上游进程外 Agent 能力也不能自动证明业务 Adapter 已隔离。

## 3. 用户、问题与产品目标

| 用户 | 当前问题 | 产品交付 |
| --- | --- | --- |
| 运营人员 | 多系统取数、比对口径与写报告耗时 | 异常工作台、证据调查、方案草稿 |
| 店长或经营负责人 | 建议缺少依据，不清楚影响和风险 | 带前后值、成本、约束和证据的审批卡 |
| 采购与库存人员 | 补货建议忽略在途、交期和活动 | 库存风险解释与补货草案 |
| 投放人员 | ROI 下降难区分流量与商品问题 | 投放、库存、促销联动诊断 |
| 管理员 | 凭据、权限、写入结果难追踪 | 数据源状态、角色策略与审计记录 |

产品目标：让一条经营异常有数据依据、有可复核解释、有明确处置方案、有受控执行、有结果追踪。

首版以工程可验收性衡量成功，不承诺收入、利润或人效提升。真实经营收益需在真实业务中通过对照与长期观测评估。

## 4. 版本范围

| 版本 | 范围 | 完成定义 |
| --- | --- | --- |
| P0 可复现闭环 | 合成数据、CSV 导入、三类异常、调查、方案、审批、模拟执行、复盘、基础评测 | 从一键演示到完整执行记录可回放，重启可恢复 |
| P1 外部试点 | 一个真实只读系统、一个支持测试环境的写 Adapter、定时运行、权限强化 | 用真实 API 契约在测试环境完成批准后执行与对账 |
| P2 生产化 | 更多平台、集中部署、组织权限与租户架构、监控运维 | 按具体组织、平台和部署需求另定验收 |

P0 包含经营规则和历史 Case 检索，不引入向量数据库、复杂预测模型或开放式多 Agent 编排。跨平台竞品自动采集、支付退款、自动投放优化、多币种核算和无人值守实盘执行不纳入首版。

## 5. 核心用户旅程与演示场景

### 5.1 主流程

1. 进入演示 Workspace 或导入数据，查看店铺范围、同步时间、缺失字段和可分析时间窗。
2. 在经营总览看到销售、毛利、库存风险和广告表现，进入某条异常。
3. 点击“开始调查”，Agent 获取商品、库存、销售、促销、广告与历史 Case。
4. 调查页逐条展示观察、假设、正反证据、替代解释和未知项。证据不全时停留在“待补证”。
5. 对比至少两个可行方案；允许其中一个为“不执行，继续观察”。
6. Reviewer 复核 SKU、时效、计算、约束与权限，未通过则返回调查或决策。
7. 负责人查看行动前后值、影响范围、证据和补偿条件，批准或驳回。
8. 执行器复核批准版本及实时状态，执行后回读对账；失败或结果不明时进入明确状态。
9. 到观察时间后生成复盘，记录实际指标、同期活动和其他干扰因素。

### 5.2 三条必须跑通的端到端场景

| 场景 | 示例信号 | 调查重点 | 可审批动作 |
| --- | --- | --- | --- |
| 销量下降与缺货风险 | SKU 销量下降且可售天数不足 | 是否缺货、在途数量、交期、流量变化、促销结束 | 创建补货草单；测试系统受理后对账 |
| 广告回报下降 | 同口径广告 ROAS 下降 | 归因窗口、库存、点击与转化、商品毛利、预算利用 | 调整指定 Campaign 预算 |
| 促销侵蚀毛利 | 券与满减后毛利低于阈值 | SKU 规格、优惠分摊、会员价、平台补贴承担方 | 调整 SKU 价格；约束不满足则拒绝 |

示例：某商品展示价 100 元、商家承担优惠 20 元、已确认平台承担补贴 10 元、成本 60 元。简化口径下商家商品收入为 90 元，商品毛利为 30 元、毛利率约 33.33%。补贴归属或费用未知时必须标记，不能把该数字称为最终净利润。

下架与对外通知属于目标动作类型，P0 保留 Schema 和拒绝策略，不提供真实执行 Adapter。补货批准表示业务请求被受理，不表示库存已经到账。

## 6. 功能需求与验收条件

| 功能 | 优先级 | 行为与验收 |
| --- | --- | --- |
| 演示与导入 | P0 | 固定种子生成数据；CSV 映射预览、校验、去重、导入摘要、错误行隔离；不运行任意 SQL |
| 数据健康 | P0 | 展示来源、时间、水位、行数、缺失和重复；关键数据过期时阻止动作建议进入审批 |
| 经营总览 | P0 | 按店铺、渠道、SKU、时间窗筛选；每项指标显示口径、截止时间与来源 |
| 异常发现 | P0 | 规则阈值与历史基线由确定性代码计算；同实体同规则同时间窗不重复建单 |
| 证据调查 | P0 | 每条事实关联证据；模型区分观察、假设与结论；不足则补查或声明无法判断 |
| 方案比较 | P0 | 展示至少两个方案、测算假设、影响范围与约束结果；不把推测收益标为事实 |
| 只读复核 | P0 | 硬规则校验必经；模型 Reviewer 可解释并要求补证，但不能覆盖硬规则失败 |
| 业务审批 | P0 | 明确审批人、对象、参数、版本、有效期和驳回原因；修改后重新审批 |
| 模拟执行 | P0 | 本地模拟系统中执行改价、预算、补货请求；支持幂等、冲突、超时与对账 |
| 复盘与 Case | P0 | 记录动作、观察窗口、结果与干扰因素；相似 Case 检索受店铺与时间范围限制 |
| 调度任务 | P0 | 基座调度触发领域运行；支持手动补跑、去重；本地程序关闭时不承诺持续监控 |
| 导出报告 | P0 | 导出 Markdown/JSON，附证据索引与运行 ID；CSV 导出对公式前缀做转义 |
| 真实系统接入 | P1 | 每个 Adapter 单独给出字段映射、权限、限流、重试、测试环境和对账方案 |

异常阈值初始可配置，如销量相较可比基线下降超过 30%、可售天数少于 7 天。它们是演示默认值，必须展示最小样本要求、可比窗口与活动影响；不能把阈值直接包装成通用行业标准。

## 7. 数据模型与计算口径

### 7.1 核心实体

| 对象 | 关键字段 |
| --- | --- |
| Product / SKU | `product_id, sku_id, source_sku_id, spec, bundle_components, channel, shop_id, currency` |
| Sales | `sku_id, ordered_qty, paid_qty, shipped_qty, refunded_qty, merchant_revenue_minor, period_start, period_end` |
| Inventory | `sku_id, warehouse_id, on_hand, reserved, inbound_qty, expected_arrival_at, observed_at` |
| Promotion | `promotion_id, sku_scope, coupon_rules, stack_rules, funding_party, valid_from, valid_to` |
| Advertising | `campaign_id, sku_scope, spend_minor, attributed_revenue_minor, attribution_window, observed_at` |
| Evidence | `evidence_id, source_id, entity_scope, query, observed_at, retrieved_at, period, quality_flags, snapshot_hash` |
| Anomaly | `anomaly_id, rule_version, entity_scope, window, severity, evidence_ids, status` |
| Investigation | `run_id, anomaly_id, stage, observations, hypotheses, counter_evidence, evidence_ids, unknowns` |
| Decision | `decision_id, version, alternatives, selected_action, evidence_ids, constraints, assumptions` |
| Approval | `approval_id, decision_id, action_hash, policy_version, approver_id, status, expires_at, approved_at` |
| Execution | `execution_id, approval_id, idempotency_key, before_version, external_request_id, status, receipt, reconciliation` |
| CaseMemory | `case_id, trigger, evidence_refs, decision_ref, outcome, confounders, compensation_ref` |

所有对象携带 `workspace_id` 和创建时间；业务实体携带店铺与渠道范围。字段存在不等于具备多租户授权，所有读写都必须由服务端校验当前上下文范围。

### 7.2 指标约定

- 金额使用最小货币单位整数；分摊和比率采用显式精度、舍入规则，禁止浮点金额直接累计。
- 商品毛利 = 商家确认的商品收入 − 商品成本；运费、平台佣金、广告等独立列示。成本缺失时不生成“毛利已满足”的结论。
- ROAS = 归因收入 ÷ 广告花费；净广告 ROI 需另定义利润口径。两者不混用，归因窗口不一致时不直接比较。
- 可售库存 = 现存 − 已占用；在途不计入即时可售。可售天数 = 可售库存 ÷ 可比窗口日均销量；零销量返回不可计算状态。
- 退款分别保留发生时间与原交易时间；不同退款口径不能直接拼接。按天统计采用业务时区，查询窗口统一为左闭右开。
- 多规格、组合装和赠品必须显式映射。无法唯一匹配 SKU 时停止下游动作，不让模型猜 ID。
- 证据记录业务观测时间与抓取时间；抓取时间很新不代表源数据很新。调查使用可复现快照，执行前读取实时版本。

## 8. Agent 架构与领域工具

```text
桌面经营工作台
  └─ 经营领域服务：对象范围校验、持久化、状态流转、事件
       ├─ 监控规则与确定性计算
       ├─ Investigation Workflow → 复用 AgentBackend / BaseAgent
       │    ├─ 经营只读 MCP Tools → Adapter → 快照与源系统
       │    ├─ 领域 Skill + 规则版本 + Case Memory
       │    └─ Reviewer：证据审查 + 硬约束校验
       └─ Approval → Execution Service → 写 Adapter → 回读对账
                     └─ 审计、幂等、状态恢复、补偿请求
```

### 8.1 六层映射与新增产物

| 层 | 基座复用 | 新增产物 | 当前状态 |
| --- | --- | --- | --- |
| External Knowledge | SourceServerBuilder、MCP Source | 经营数据契约、CSV Adapter、模拟系统 Adapter、只读 MCP Server | 计划中的场景扩展 |
| Harness | PreToolUse、PromptBuilder、工具定义 | 分阶段工具面、上下文快照、业务范围校验、只读 Reviewer 工具集 | 计划中的场景扩展 |
| Runtime | AgentBackend、会话、自动化服务 | 领域 Run 状态、任务锁、超时、补跑、失败恢复 | 计划中的场景扩展 |
| Memory | Session JSONL | 规则版本库、事务型业务存储、证据快照、Case 检索 | 计划中的场景扩展 |
| Eval | 基座事件与现有测试框架 | Trace Schema、场景数据集、评分器、安全回归门禁 | 计划中的场景扩展 |
| Workflow | 计划展示与会话交互 | Monitor 至 Review 状态机、业务审批、执行与对账 | 计划中的场景扩展 |

该表记录设计状态，不证明用户个人 Ownership，也不作为已实现简历素材。

### 8.2 拟建工具契约

| 工具名 | 用途 | 权限 |
| --- | --- | --- |
| `retail_get_data_health` | 查询数据水位与质量 | 只读 |
| `retail_query_metrics` | 查询白名单指标、维度和窗口 | 只读 |
| `retail_get_sku_context` | 查询商品规格、库存与在途 | 只读 |
| `retail_get_promotions` | 查询优惠叠加及承担方 | 只读 |
| `retail_get_campaigns` | 查询投放与归因口径 | 只读 |
| `retail_search_cases` | 检索已复核历史案例 | 只读 |
| `retail_simulate_actions` | 按规则测算方案与约束 | 无外部写入 |
| `retail_submit_decision` | 保存方案草稿并请求审批 | 可写内部草稿，不能批准或执行 |

统一查询范围包括 `workspace_id, shop_id, channel, sku_ids, period, as_of`。工具返回 `data, evidence_ids, observed_at, retrieved_at, quality_flags, partial, error_code`。缺数不得伪装为零值；部分失败保留已获取证据与失败说明。

价格、预算与补货写入只由 Execution Service 调用 Adapter，不暴露给模型为可直接执行的 MCP Tool。审批人身份来自可信会话上下文，不由模型工具参数提供。

### 8.3 模型与确定性代码的职责

- 模型负责问题分解、选择只读查询、归纳证据、提出假设、解释方案与生成报告。
- 代码负责指标计算、阈值判定、Schema 校验、SKU 身份、规则约束、授权、状态迁移和实际执行。
- 首版采用单主 Agent 与串行只读 Reviewer，不新增并行子 Agent 编排；工具能力集合由服务端限制。
- 按阶段装配工具与必要上下文，长表由工具聚合。每个 Run 初始限制 30 次工具调用、5 分钟、2 轮补证；达到上限保留中间结果并明确退出原因。
- 外部数据与历史 Case 都视为业务内容，不能改变系统指令或授予权限。

### 8.4 持久化与恢复

新增每 Workspace 的 SQLite 业务库，保存异常、调查、方案、审批和执行账本；证据大文件以内容摘要索引保存在 Workspace 的 `retail/evidence/`，避免将大量原始业务数据写入 Prompt 或聊天 JSONL。SQLite 驱动在第一阶段通过 Bun、Electron 服务端运行方式与打包兼容性验证后确定，不能假设 Electron 主进程可直接使用 Bun 专属 API。

数据库迁移带版本并可备份恢复；动作提交与待执行事件在同一事务记录，由执行器领取。已有聊天记录继续使用上游存储，两套数据通过 `session_id/run_id` 关联。应用重启后依据业务账本恢复，不能依据聊天中“已执行”的文本恢复。

## 9. 审批、执行与失败处理

### 9.1 状态机

```text
经营 Run：CREATED → MONITORING → DETECTED → INVESTIGATING
       → DECIDING → REVIEWING → WAITING_APPROVAL
       → EXECUTING → OBSERVING → CLOSED

分支：NEEDS_EVIDENCE / REJECTED / CANCELLED / FAILED

Approval：PENDING → APPROVED / REJECTED / EXPIRED / SUPERSEDED

Execution：QUEUED → EXECUTING → SUCCEEDED
                        ├─ FAILED
                        └─ UNKNOWN → RECONCILING → SUCCEEDED / FAILED / MANUAL_REVIEW
```

阶段名称与“通过条件”绑定。Reviewer 在执行前复核；业务 Review 阶段则观察执行结果，二者分开保存。

### 9.2 审批与执行规则

1. 方案绑定对象、前后值、证据快照、约束版本、参数摘要和有效期；P0 默认有效期 30 分钟，可配置。
2. 审批页面必须显示数据来源和时间、测算假设、影响范围、风险、执行方式与补偿条件。
3. 业务角色分为 Analyst、Approver、Executor、Admin。P0 本地单用户可演示不同角色，但不能声称具备独立审批人的身份保证；外部试点前接入可信身份与角色验证。
4. 批准仅绑定具体版本；SKU、参数、证据有效性、规则或目标实时版本变化，均使授权失效并要求重新校验，必要时重新审批。
5. 执行前从可信批准记录构造请求，复核身份、范围、毛利下限、预算上限、库存条件、有效期和目标版本。
6. 使用稳定幂等键和本地唯一约束避免重复提交。外部系统无幂等能力且结果未知时，停止自动重试，转查询对账或人工核查；不承诺跨系统 exactly-once。
7. 记录外部请求号、请求摘要、前后值和回读结果。多动作方案拆为独立执行项，展示部分成功，不宣称跨平台原子事务。
8. 回滚是有条件的补偿动作：先读取当前状态，防止覆盖他人后续修改，重新审批。已受理补货单可能只能申请取消；无法补偿时转人工处理。
9. 通用 `allow-all` 不绕过业务规则；Source、HTTP、Shell、脚本或文件工具不得形成业务写入旁路。经营工作流禁用任意 Shell、脚本与通用写 API，只连接只读业务凭据；写凭据由执行服务独占。

### 9.3 关键故障行为

| 故障 | 预期行为 |
| --- | --- |
| 数据源不可用或缺数 | 标记部分数据，保留原始错误，不生成确定性结论 |
| 数据过期或 SKU 歧义 | 请求同步或人工映射，禁止推进动作 |
| 审批后价格或预算被他人修改 | 版本冲突，不覆盖，回到方案确认 |
| 执行超时 | 标为 UNKNOWN，先对账再决定重试 |
| 审批或执行时应用退出 | 重启从账本恢复；执行中条目先对账 |
| Reviewer 不通过 | 保留原因与规则，回到调查或决策，不能直接强行执行 |
| 达到模型预算或工具次数上限 | 输出未完成报告，保留证据与可继续位置 |

## 10. 产品页面与交互

| 页面 | 内容与主要操作 |
| --- | --- |
| 经营总览 | 核心指标、口径、数据新鲜度、待处理异常、待审批事项；演示入口 |
| 异常中心 | 按店铺、类型、优先级、状态筛选；规则与基线可解释；发起调查 |
| 调查工作台 | 左侧异常与阶段，中间 Agent 调查，右侧证据、未知项和事件；支持中止与续查 |
| 方案与审批 | 方案比较、测算、前后值、硬约束、复核结论；批准、驳回、过期提示 |
| 执行与复盘 | 执行状态、请求号、对账、补偿申请、观察窗口和 Case |
| 数据与规则 | 导入、字段映射、Source 健康、毛利与预算规则、数据时效配置 |
| 设置 | 模型连接、凭据、角色、成本上限、审计导出 |

聊天仍是调查交互的一部分，首页和主导航围绕经营对象组织。证据可点击定位到对应快照与筛选条件；审批按钮只能在复核通过且数据有效时启用。所有页面覆盖加载、空数据、部分失败、权限不足和过期状态。

## 11. 新项目结构与源码改动面

计划交付目录：`D:/helson-skills/craft-agents-oss-main/retailpilot-agent`。本轮不创建完整源码副本，不修改原始项目。

```text
retailpilot-agent/
  apps/electron/                  # 经营 UI、导航、品牌、安装包
  apps/webui/                     # P1 经营页面共享入口
  packages/retail-domain/         # 实体、规则、计算、状态机、持久化接口
  packages/retail-adapters/       # CSV、模拟系统、后续真实 API
  packages/retail-mcp-server/     # 只读经营工具与输入输出契约
  packages/retail-eval/           # Trace、数据集、评分器、回归门禁
  packages/server-core/          # 经营服务组装、可信接口、执行器
  packages/shared/               # 基座复用与少量治理、上下文接入
  packages/session-tools-core/   # 必要桥接，避免领域逻辑挤入通用工具
  resources/retail/              # 领域 Skill、规则模板、数据映射
  fixtures/retail/               # 固定种子合成数据、预期事件
  docs/                         # PRD、架构、数据字典、演示与验收记录
```

接口建议采用领域服务方法与现有 RPC 风格对接，不额外维护一套无需求的 REST 服务：`listAnomalies`、`startInvestigation`、`getEvidence`、`submitDecision`、`approveDecision`、`rejectDecision`、`getExecution`、`requestCompensation`。审批与执行接口仅允许可信 UI/服务身份调用，不能注册到模型可调用工具集合中。

新项目复制完成后记录上游版本、文件摘要与改动清单，保留许可证和来源说明；新建项目自己的 Git 历史。按本地 `TRADEMARK.md` 中的 Fork 要求替换产品名、图标、appId 和相关默认服务地址。内部包名与序列化字段按兼容性逐项迁移，避免全局替换破坏协议；原始版权声明不删除。

需检查更新器、分享查看器、OAuth 回调、遥测与错误上报配置，避免派生项目默认使用未经配置的上游产品服务。P0 未配置的外部分享和更新入口关闭，模型与用户显式配置的 Source 保持可用。

## 12. 评测、质量与交付门禁

### 12.1 场景数据集

计划建立不少于 48 个可重放样例：12 类 Failure Mode × 正常、异常、证据不足三类，加 12 个审批及执行故障样例。每例包含输入快照、规则、允许结论范围、必需证据、禁止动作和期望状态，不依赖固定自然语言答案。

12 类至少包括：券与满减叠加、多规格、组合装、赠品、会员价、平台补贴承担方、延迟数据、无货价格、SKU 错配、异常销量、毛利冲突、广告归因窗口错配。

额外覆盖：未审批执行、审批过期、参数替换、跨店铺读写、Auto 旁路、重复请求、并发批准、执行超时、对账失败、应用退出、部分成功、补偿冲突。

### 12.2 验收标准

| 项目 | P0 门禁 |
| --- | --- |
| 数据与计算 | 确定性样例的 SKU 身份、金额、优惠分摊与指标计算全部符合预期 |
| 安全 | 安全样例未授权写入为 0；有效禁止动作命中即阻断发布 |
| 证据 | 三个主场景中所有事实型决策依据具备可解析证据引用，样例覆盖率 100% |
| 异常检测 | 输出固定数据集的混淆矩阵、误报与漏报；演示规则关键样例全部命中预期，不外推真实准确率 |
| Agent 调查 | 三个主场景分别完成 5 次真实模型运行，至少 4 次满足结论与证据契约；任一次越权均失败；报告模型、提示词与运行配置 |
| 幂等与恢复 | 重复提交不重复产生模拟副作用；UNKNOWN 不盲目重试；重启可恢复待审批和待对账记录 |
| 可操作性 | 三个场景可由 UI 从异常进入最终复盘；错误、驳回与过期均有可理解提示 |
| 性能目标 | 固定 10 万行本地数据集下常用指标查询 p95 ≤ 2 秒，连续 30 次测量，记录机器与缓存条件；模型耗时单独统计 |
| 安装 | Windows 安装、首次启动、演示数据、模型配置、重启恢复、卸载策略均有验收记录 |

上述数字是拟定发布目标，当前没有测试结果。模型运行不可用时仅可交付“确定性回放版”，不得替代真实 Agent 验收。

Trace 至少记录 `run_id, session_id, stage, tool_call_id, tool_name, input_hash, evidence_ids, policy_version, model_config, duration, token_usage, error_code`，并关联审批和执行 ID。日志过滤凭据、个人信息和不必要的原始业务数据。

### 12.3 验证层次

1. 领域单测：计算、匹配、状态迁移、规则冲突与审批版本。
2. Adapter 契约测试：字段、时效、分页、限流、超时、部分失败。
3. 集成测试：持久化、任务去重、批准后执行、重启与对账。
4. UI 端到端测试：三条主场景与审批失败路径。
5. Agent Eval：确定性 Trace 断言为硬门禁，模型评分仅补充语义质量。
6. 影响范围内的上游类型检查与相关回归；Windows 不兼容的 Bash 脚本明确替换或记录，不把未执行检查写为通过。

## 13. 实施阶段与交付安排

工作量估计以一名熟悉 TypeScript/Agent 的开发者、全职投入、无真实平台接入阻塞为前提；为范围估算，不是日历承诺。P0 约 25–35 个工作日，P1 真实系统试点另计，初估 5–15 个工作日且依赖平台条件。

| 阶段 | 估计 | 交付 | 阶段完成条件 |
| --- | --- | --- | --- |
| M0 基线与可运行性 | 2–3 天 | 独立项目、来源摘要、依赖基线、品牌配置、Windows 启动记录、SQLite 运行验证 | 原始源码可启动，新目录独立运行，阻塞项明确 |
| M1 数据与规则 | 4–5 天 | 领域包、数据字典、导入、合成数据、指标与异常规则、持久化 | 确定性计算与导入质量测试通过 |
| M2 Agent 调查 | 4–6 天 | 只读 MCP、Skill、证据快照、调查状态、只读 Reviewer | 三个场景均可生成有引用的调查与方案 |
| M3 审批与执行 | 5–7 天 | 审批 UI、业务授权、模拟写系统、执行账本、对账与补偿 | 越权、过期、重放、未知结果、重启测试通过 |
| M4 经营工作台 | 5–7 天 | 总览、异常、调查、审批、执行复盘、数据设置、演示导航 | UI 三场景闭环可走通，空态与失败态完整 |
| M5 评测与打包 | 5–7 天 | 48+ 样例、真实模型评测、安装包、报告、架构与演示文档 | 达到第 12 节门禁；残余风险明确 |

首个可展示切片安排在 M2：单个“促销侵蚀毛利”场景完成导入 → 确定性规则 → Agent 调查 → 证据方案。随后 M3 补齐审批与模拟执行，再扩展三场景和完整 UI。

依赖顺序：数据契约先于页面汇总，审批契约先于写 Adapter，确定性规则先于模型 Reviewer，执行账本先于故障重试。阶段开始前将计划中的接口固化为独立设计文档与测试样例。

## 14. 风险、取舍与待定参数

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 基座体量大、依赖安装或 Windows 脚本失败 | 影响启动和打包估算 | M0 优先探明；记录可复现修复，不先大量改 UI |
| 无真实业务系统 | 不能证明平台接入和生产效果 | P0 明示模拟环境；P1 每个 Adapter 独立验收 |
| 优惠和广告口径不完整 | 错误毛利与归因 | 显式数据契约；未知则补证和阻断 |
| 通用 Agent 工具可旁路 | 未批准写入 | 领域会话裁剪工具；读写凭据分离；执行服务唯一持有写凭据 |
| 真实平台缺乏幂等和版本控制 | 重复动作或覆盖人工操作 | 对账、前置值比较、保守重试与人工核查 |
| 本地应用退出 | 漏跑监控 | 明示运行要求；补跑去重；需要持续服务时再部署独立服务端 |
| 审批角色只是本地模拟 | 不能满足多人制衡 | P0 如实标记；试点前补真实身份与角色 |
| 模型幻觉或重复调用 | 无证据结论、成本不可控 | 计算外置、证据引用、工具/时间预算、硬约束与 Eval |

实施时可先沿用以下默认选择：独立目录、TypeScript 技术栈、Windows 首发、单组织多店铺、合成数据与 CSV、模拟执行、三条主场景。真实平台名称、店铺数量、审批身份、指标细则、API 凭据与部署环境待试点时补齐；这些信息不妨碍 P0，但会影响 P1。

## 15. 最终交付清单与验收演示

计划交付：独立可运行的新项目源码、Windows 安装包、环境与启动说明、数据字典、领域工具契约、规则与 Skill、合成数据与导入模板、数据库迁移、场景数据集、评测报告、操作手册、上游来源与改动说明。

验收演示按以下顺序进行：

1. 安装并打开 RetailPilot，载入演示数据，解释指标口径与源数据时间。
2. 展示三类异常，选择促销毛利案例开始调查，逐条查看证据和替代解释。
3. Reviewer 驳回一条违规方案，再给出满足约束的方案及“不行动”备选。
4. 展示未审批无法写入，批准后在模拟系统执行并回读。
5. 注入一次重复提交和一次超时，展示幂等与 UNKNOWN 对账。
6. 重启应用，恢复待审批和执行状态，打开复盘 Case 与完整 Trace。
7. 展示评测报告中的实际通过情况、失败样例与尚未支持的真实系统。

只有源码、测试、Trace 与可运行入口具备之后，才能将相应模块从“计划中的场景扩展”更新为“原型”或“已实现”。项目源码能力、个人参与事实与真实业务效果分别记录。

## 附录：来源导航

- 场景选择：`C:/Users/29486/.codex/skills/craft-agents-resume-skill/references/scenario-router.md`，F6 与 `ecommerce-operations`。
- 场景要求：同 Skill 的 `references/scenario-architecture.md`，第 5、7 节。
- 状态与事实边界：同 Skill 的 `references/agent-project-modeling.md`，第 1、3、4 节。
- 本地基座证据：本文第 2 节源码表；各路径相对于用户指定源码根目录。
- 产品派生配置依据：源码根目录下 `LICENSE`、`NOTICE`、`TRADEMARK.md`，以及 `apps/electron/electron-builder.yml`、`packages/shared/src/branding.ts`。

本文是 PRD 与工程实施方案，不是简历生成包，因此不输出简历 Bullet 候选菜单或将规划包装成已交付经历。
