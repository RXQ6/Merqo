# M0 领域契约与持久化决策

日期：2026-10-15。状态：契约原型，尚未接入桌面业务流程。

## 可执行契约

源码：`packages/retail-domain/src/index.ts`，运行时校验使用 Zod；TypeScript 类型从 Schema 推导，ID 为带品牌的非空字符串。顶层对象拒绝额外字段。

| 对象 | 约定 |
| --- | --- |
| Scope | 每条数据携带 Workspace、店铺、渠道。Schema 检查不替代服务端身份授权 |
| Period | 带偏移的 ISO 时间，固定业务时区 Asia/Shanghai，左闭右开，开始早于结束 |
| SKU | 显式源 SKU 与规格；成本可缺失；首版仅 CNY |
| Sales | 已支付数量、退款数量、商家商品收入，金额为安全整数分 |
| Inventory | 现存、占用、在途分别记录；占用不得超过现存 |
| Promotion | 承担方与叠加规则可标 unknown，不能默认为商家或允许叠加 |
| Evidence | 来源、观察时间、抓取时间、期间、SKU 范围、SHA-256、质量标记 |
| Action | 改价、预算、补货请求三个判别类型；每个动作绑定目标版本；无删除动作 |
| Decision | 版本、证据、规则版本与动作；动作范围必须与方案一致 |
| Approval | 审批状态为判别联合；批准状态必须带审批人及批准时间 |
| Execution | 幂等键、批准记录、外部请求号与回执；显式 UNKNOWN 与对账状态 |

Schema 不检查审批人是否有权、授权是否过期、规则是否满足、Hash 是否与真实参数一致。这些属于 M3 服务端业务规则，不能用“输入校验通过”替代“允许执行”。广告 Schema、规则版本、异常与调查完整 Schema 在 M1 继续补齐。

## 持久化选择

选定验证路线：**Bun 子进程持有 SQLite；Electron/Node 宿主通过受控进程协议调用。** 不将 `bun:sqlite` 导入 Electron 主进程或 renderer，不新增绑定 Electron ABI 的原生数据库包。

探针文件：

- `scripts/retailpilot-sqlite-probe.ts`：创建独立探针数据库，验证版本、WAL、事务回滚、幂等键唯一约束、外键与关闭后重开。
- `scripts/retailpilot-persistence-host.cjs`：从 Node 或 Electron Node 模式启动 Bun，设置超时并校验 JSON 结果。

探针数据库位于 `.runtime/sqlite-probe/compatibility.sqlite`，只能作兼容性证据，不能作真实业务库。已经验证开发环境 Node 24.15.0、Electron 39.2.7 的 Node 22.21.1 → Bun 1.4.2 → SQLite 的链路。

M1 将在这一边界实现请求 ID、白名单操作、输入校验、持久工作进程、关闭时 flush、结构化错误、逐版本迁移、备份恢复与业务表。M3 再实现审批、执行账本及 outbox 的同事务写入。

安装包必须携带 Bun 可执行文件，不能依赖终端 PATH；已有上游打包流程有 vendor/bun 约定，但本阶段未验证安装包内的持久化链路。

## 下一条垂直切片

促销侵蚀毛利：固定合成数据 → 字段映射与质量检查 → 确定性优惠计算 → 异常 → 只读 Agent 工具 → 有证据的方案草稿。批准与执行不先于账本和服务端业务权限实现。
