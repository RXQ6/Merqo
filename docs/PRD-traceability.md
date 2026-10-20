# PRD 开发与验收追踪矩阵

更新：2026-10-20。基线为已发布beta.3的`7d20d1f`及本轮本地改动；原始规格：[PRD v0.1](PRD-v0.1-2026-10-15.md)。不修改原始PRD，不以本地模拟代替真实平台和外部验收。

**最新入口：[开发主线](development-progress-2026-10-20.md)及[本轮验收](verification/acceptance-2026-10-20/report.md)。** beta.3已发布；本轮新增功能进入beta.4本地候选包，不自动视为GitHub发布。[上轮验收](verification/route-final-2026-10-19/report.md)保留历史。安全证据见[安全映射](M5-security-acceptance.md)。

2026-10-19后续已实现[业务时间分离](M5-business-time.md)、[旁证冻结](M5-related-evidence.md)、[直接改价](M5-price-action.md)、[可配置规则](M5-business-policy.md)、[来源声明](M5-source-metadata.md)，以及[显式映射与共同窗口/水位](M5-catalog-joint-design.md)。历史业务日不因重导入变新；缺规格、跨窗及多实体保持补证。CSV身份未认证，联合结论只允许描述性比较。

最新持续开发进度见[路线记录](M5-route-progress-2026-10-19.md)。交易事件账本、显式商品映射、v2共同窗口/水位、两轮补证及独立30次工具上限已有实现；新路线6项、三场景最终Case、广告驳回重提、实际审批过期/服务器拒绝、Auto后端Bash/Write阻断与重启均已通过。

## 当前开发位置

**M0–M4本地主干已实现；M5已完成本轮源码、桌面及性能回归，新包验收见报告。分次支付、取消、实物退回、显式换货、订单优惠分摊及嵌套组合装已补开发。仍有限定契约、真实接入及外部验收边界，不能称全PRD100%。**

beta.3是上一轮已发布版本；当前beta.4候选及本轮验收不构成新的真实模型质量评测。历史真实模型15次12通过、各场景4/5，3次失败保留。详细记录：[真实模型评测](M5-live-evaluation.md)。

状态含义：**已实现**表示存在实现和对应验证入口，限于表中边界；**部分**表示仍有原条文未覆盖；**待开发**表示没有可验收实现；**待验收**表示尚缺足够验证材料。下表路径相对于仓库根目录，测试入口表示覆盖位置，不表示本次重新执行。

## 第 6 节：功能需求

| ID | PRD 要求 | 状态 | 实现 / 验证入口 | 剩余工作或边界 |
| --- | --- | --- | --- | --- |
| F01 | 固定演示、CSV 映射、校验、去重、错误隔离 | 已实现 | `operations.ts`、`store.ts`、`signals.ts`、`signal-store.ts`；`operations.test.ts`、`signals.test.ts` | 均位于 `packages/retail-domain/src/`；CSV 仅分析，模拟处置限定内置 demo |
| F02 | 来源、水位、行数、缺失、重复；过期阻断 | 已实现（本地声明范围） | `source-metadata.ts`、`joint-evidence.ts`、对应测试 | 三场景独立来源/观测/覆盖声明与共同最慢水位已核对；CSV身份未认证，旧批次不补造元数据；真实平台认证属于后续接入 |
| F03 | 总览范围筛选、指标口径、截止时间和来源 | 已实现（本地声明范围） | `retail-query.ts`、`signal-query.ts`、`ScopeEvidence.tsx`及对应测试 | 三场景展示范围业务日期、批次/源观测/覆盖水位，不随搜索状态分页缩小；最多30批并显式提示截断，不把日期范围或导入时间当完整证明。见本轮桌面与十万行性能 |
| F04 | 确定性异常规则、基线、重复建单限制 | 已实现 | `operations.ts`、`signals.ts`、`scheduled-checks.ts`；对应同名测试 | 版本化演示规则；配置入口另见差异 D02 |
| F05 | 事实证据、观察/假设分离、补证 | 已实现（本地分析范围） | `supplement.ts`、`investigation-store.ts`、`joint-evidence.ts`；对应测试 | 两轮补证预览、独立子调查、重新复核、保留旧报告；联合证据仅允许同规格/窗口/唯一范围并列描述，不证明因果 |
| F06 | 至少两个方案、假设、范围、约束 | 已实现 | `investigations.ts`、`signal-investigations.ts`、`decisions.ts`；调查及决策测试 | 包含不执行；条件测算不代表因果收益或需求预测 |
| F07 | 硬规则必经、只读 Reviewer 不得覆盖失败 | 已实现 | `readonly-tools.ts`、调查服务、数值审计；调查与数值测试 | Reviewer仍可要求补证；本轮协议夹具不计真实模型质量，历史15次12通过及3次失败保留 |
| F08 | 审批人、对象、参数、版本、有效期、驳回原因 | 已实现 | `approval-types.ts`、`decisions.ts`、`decisions.test.ts` | P0 为本地模拟身份，无可信多人审批保证 |
| F09 | 模拟改价、调预算、补货；幂等、冲突、超时对账 | 已实现 | `price-action.ts`、`simulation.ts`、`decisions.ts`、`execution-batches.ts`；[改价验证](M5-price-action.md) | 三种动作在本地模拟范围实现；直接价格与减券分开审批，共享资源冲突受控；不构成真实平台写入 |
| F10 | 复盘、结果、干扰因素、范围受限 Case | 部分 | `outcome-reviews.ts`、`readonly-tools.ts`；`decisions.test.ts` | 合成观察与 Case 已实现；没有真实实施后效果观测，不能证明收益 |
| F11 | 调度、手动补跑、去重、退出限制 | 已实现 | `scheduled-checks.ts`、`scheduled-checks.test.ts` | 程序关闭不持续巡检；漏跑显式展示和补跑 |
| F12 | Markdown/JSON、证据索引和运行 ID、CSV 公式转义 | 已实现 | `investigation-export.ts`、`operations.ts`；`decisions.test.ts`、`operations.test.ts` | 导出保留未知项和模拟边界 |
| F13 | 真实系统 Adapter 契约及对账 | 接入准备中 | `adapters/doudian-request.ts`及测试；[抖店路线](P1-doudian-integration-plan.md) | 用户选择抖店且尚未开通应用；离线签名/只读分页请求已做，真实授权、同步、对账及写入未交付，不计入P0真实接入 |

上述领域源码和同名测试默认均位于 `packages/retail-domain/src/`。

## 第 7 节：实体与计算口径

| ID | PRD 要求 | 状态 | 实现 / 验证入口 | 差异与完成条件 |
| --- | --- | --- | --- | --- |
| D01 | 价格/促销实体和直接 SKU 改价 | 已实现 | `price-action.ts`、`price-action.test.ts`；[闭环与原生验证](M5-price-action.md) | 独立改价贯通测算、调查、审批、模拟执行和回读；安全补偿可执行，不安全原价恢复被拒；会员价等限制仍明确保留 |
| D02 | 示例阈值和规则可配置 | 已实现 | `business-policy.ts`、`policy-store.ts`、`business-policy.test.ts`；[原生配置验证](M5-business-policy.md) | 默认/店铺覆盖、阈值与样本/窗口、审批期限和改价幅度受校验并版本化；变更后旧审批失效 |
| D03 | 订单/支付/发货/退款数量与退款双时间口径 | 已实现（限定契约） | `transactions.ts`、`transaction-store.ts`、`transactions.test.ts`；[扩展契约](M5-transaction-extension.md) | 分次支付结清只计一次件数；取消、实物退回及显式换货关联、部分退款和双时间；未结清只整行取消，不自动净额结算或库存回补 |
| D04 | 商品、规格、组合装、赠品、会员价映射 | 已实现（限定本地契约） | `catalog.ts`、`bundles.test.ts`、`order-allocation.ts`及测试；赠品/会员/报价测试 | 显式规格映射、最多6层500子项组合树及行级订单分摊已实现；活动资格/门槛引擎、真实目录及会员身份认证、多币种仍不在当前范围 |
| D05 | 库存、占用、在途、ETA、观测时间 | 部分 | `signals.ts`、`inventory-numeric.ts`、`source-metadata.test.ts` | 数量、日期及独立来源时刻/水位声明已有；CSV 平台身份与真实库存完整性未独立验证 |
| D06 | 广告花费、归因收入、窗口、观测时间 | 已实现（本地分析范围） | `signals.ts`、`catalog.ts`、`joint-evidence.ts`；对应测试 | 归因口径、独立来源时刻、水位、显式广告SKU规格映射和共同窗口已实现；多活动/不同窗不自动汇总，CSV身份不等于已认证 |
| D07 | Evidence 来源、查询、范围、业务窗、时间、摘要 | 已实现（本地声明范围） | `source-provenance.ts`、`catalog.ts`、`joint-evidence.ts`、只读工具及导出 | v2 冻结来源、映射版本、共同窗口和水位，别名只按显式映射取数；历史v1不回填；真实平台认证属接入阶段 |
| D08 | Anomaly/Investigation/Decision/Approval/Execution/Case | 已实现 | `investigation-store.ts`、`decisions.ts`、`outcome-reviews.ts`、对应测试 | 以当前领域对象表示，未要求所有类型名称与 PRD 完全一致；组织多租户不在本项证明范围 |
| C01 | 最小货币单位整数、明确舍入 | 已实现 | `operations.ts`、`margin-numeric.ts`、`margin-numeric.test.ts` | 限定商品毛利；不含全部净利润成本 |
| C02 | ROAS 与 ROI 分离、归因窗口一致 | 已实现 | `signals.ts`、`ads-numeric.test.ts`、`signals.test.ts` | 条件预算缩放不宣称改善 ROAS |
| C03 | 可售不含在途、零销量不可计算 | 已实现 | `inventory-numeric.ts`、`inventory-numeric.test.ts` | 分数和单位保留；补货受理不等于到货 |
| C04 | 业务时区、左闭右开窗口、退款双时间 | 已实现 | `evidence-policy.ts`、`transactions.ts`、`transactions.test.ts` | Asia/Shanghai半开日期窗；退款发生期与原订单归属期分别查询。归属期是截至当前已导入事件的队列视角，不冒充历史期末报表 |
| C05 | SKU 不能猜测、快照可重现、执行前版本复核 | 已实现 | 导入、只读工具、`decisions.ts`；`operations.test.ts`、`decisions.test.ts` | 冻结范围内校验，不证明外部目录匹配 |

## 第 9 节：流程、安全与故障

| ID | PRD 要求 | 状态 | 实现 / 验证入口 | 边界或剩余验收 |
| --- | --- | --- | --- | --- |
| W01 | 调查到审批执行复盘状态持久化 | 已实现 | `investigation-store.ts`、`decisions.ts`、`outcome-reviews.ts` | `investigations.test.ts`、`decisions.test.ts` 与桌面重启归档 |
| W02 | 参数、快照、规则、摘要、有效期绑定 | 已实现 | `decisions.ts`、`approval-types.ts`、`business-policy.test.ts` | 默认及店铺审批/补偿期限可配置；创建时冻结期限与规则版本，变更不续期且使旧审批失效 |
| W03 | 审批可见来源、假设、范围、风险及补偿 | 已实现（本地模拟范围） | `ApprovalsPanel.tsx`、`decisions.ts`；本轮改价及三场景闭环归档 | 风险/来源为各状态共用详情；三场景审批、广告驳回重提及实际过期通过；独立补偿、UNKNOWN先对账和后续变更禁止覆盖均明确展示 |
| W04 | 角色校验和可信身份 | 部分 | 本地 approver/executor 校验及伪造请求测试 | P0 本地模拟角色；外部可信身份属于 P1 |
| W05 | 授权仅对应具体版本、改动失效 | 已实现 | `decisions.test.ts`、`price-action.test.ts`、`business-policy.test.ts` | 价格/券/补货/预算及补偿均绑定具体版本，规则配置变更失效与 ABA 已验证 |
| W06 | 幂等、UNKNOWN 对账、独立多动作、部分成功 | 已实现 | `simulation.ts`、`execution-batches.ts`；`decisions.test.ts` | 本地模拟账本，不声称跨系统 exactly-once |
| W07 | 有条件补偿、重新审批、防覆盖后续修改 | 已实现 | `compensation.ts`；`decisions.test.ts` | 已受理补货不能视为已收货或任意取消 |
| W08 | Auto/通用工具不能形成业务写入旁路 | 已实现（本地边界） | `retail-tool-boundary.ts`、`injection-boundary.test.ts`、实际PiAgent Auto检查 | 经营空间通用工具强制只读，先于Auto/Ask及自定义授权；实际Bash/Write被拒，账本未变；有限样例不证明全攻击安全 |
| W09 | 缺数、过期、SKU 歧义停止推进 | 部分 | `evidence-policy.ts`、调查/决策测试 | 字段缺失、导入过期、历史/超前业务日阻断已有；日期精度不等于源观测时刻，剩余来源缺口见 F02/D07 |
| W10 | Reviewer 驳回保留、预算耗尽保留、恢复 | 已实现（限定预算） | `investigation-resume.test.ts`、`supplement.test.ts`、`investigation-limits.ts` | 独立30次工具调用上限、两轮补证；原14次模型请求限制仍额外保留。暂停恢复不清空工具/模型预算，补证创建有父关联的新Run |

## 第 12 节：发布门禁

| ID | 门禁 | 当前证据 | 判定与缺口 |
| --- | --- | --- | --- |
| G01 | 数据与计算正确 | 固定业务评测、本轮295项领域回归及独立抖店离线测试 | 限定本地契约有证据；新交易/组合树/分摊另有针对回归，不以固定48例或本地声明证明真实平台数据完整性 |
| G02 | 未授权写入为零 | 决策/调查/MCP、CSV/Case注入矩阵及实际Auto后端；最终15次模型禁止事件0 | 本地有限验收满足，证据见本轮安全报告；不扩大为安全全覆盖 |
| G03 | 三场景事实依据全部可解析引用 | 三个 numeric 契约及 [v4 批次](verification/live-eval-inventory-facts-2026-10-18/report.md) | 当前冻结契约有证据；缺完整跨源证据时不应生成联合事实 |
| G04 | 固定集混淆矩阵和关键异常命中 | [固定评测归档](verification/business-eval-final-2026-10-18/report.md) | 已有限定固定集报告；不外推真实准确率，保持整体 releaseReady=false |
| G05 | 每场景真实模型5次、至少4次通过、越权零 | 本轮三场景各4/5，禁止事件0，live-final/report.json | 达到预设门槛，3次失败保留；首次评分器契约失败也独立保留 |
| G06 | 幂等、UNKNOWN、重启恢复 | `decisions.test.ts`、[本轮归档](verification/inventory-numeric-2026-10-18/checks.json) | 本地模拟范围已验证；不是外部系统证明 |
| G07 | 三场景UI到最终复盘及错误/驳回/过期提示 | 本轮三场景最终Case、广告驳回重提、实际过期与服务器拒绝、重启留存通过 | 与原错误/缺证/UNKNOWN/补偿回归共同构成本地范围验收；协议夹具不代表模型质量 |
| G08 | 十万行、30次、常用查询p95≤2秒 | 2026-10-20毛利722.57ms、库存656.27ms、广告647.10ms，各30次 | 限定查询通过；[本轮报告](verification/acceptance-2026-10-20/report.md)保留初版2320.63ms失败及索引修复，不证明冷盘、并发、完整UI绘制或两秒内导入 |
| G09 | Windows 安装、配置、重启、卸载 | beta.3历史生命周期、本轮beta.4本地候选见最新验收报告 | 新源码与beta.3发布明确分开；干净环境/其他Windows版本、NSIS跨版本升级与签名仍待验收 |

## 接下来按什么顺序开发

1. 本轮已补齐交易扩展、优惠分摊、嵌套组合树、三场景来源展示和审批风险文案，并通过领域、桌面和性能验证；新包状态见[最新验收](verification/acceptance-2026-10-20/report.md)。
2. 保留CSV本地版。抖店应用开通后继续安全凭据、真实只读同步、字段映射、售后/支付明细及后台对账；当前离线准备不算已连接店铺。
3. 可信多人审批、真实写入及真实效果观察另行验收；干净Windows与其他Windows版本等待外部测试环境。

退款明细和复杂优惠引擎须先固化数据语义，再实施；不通过修改历史 PRD 或测试预期消除差异。该矩阵当前是开发清单，不是用户对规格变更的批准。

## 上一轮beta.3交付补记（历史）

本地路线已完成并通过beta.3安装验收；新增打包功能6项、随包三场景及模拟执行/暂停恢复/分页/重启/重装/卸载通过，复制beta.2 profile迁移通过。G09本轮本机范围满足；NSIS跨版本升级、干净Windows及其他Windows版本未本轮验证。具体版本、校验值及限制见[最新报告](verification/route-final-2026-10-19/report.md)，旧状态行属于构建中记录。
