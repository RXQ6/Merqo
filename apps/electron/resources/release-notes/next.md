# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **RetailPilot 促销毛利工作台** — 演示快照、CSV 映射预览与错误行隔离、确定性毛利预警、证据详情和导出，支持 SQLite 批次历史、重复导入与重启恢复。

- **促销毛利调查** — 在异常商品旁开始只读调查，查看引用证据、原因假设、两个方案的代码测算和串行复核。支持 API 连接及明确标注的离线规则演示，调查记录重启后保留；审批支持本地模拟处理，业务执行尚未接入。

- **RetailPilot M0 foundation** — Independent desktop identity and local data, disabled unconfigured upstream sharing and updates, and initial retail domain contracts. Business investigation and execution follow in later milestones.

- **库存与广告调查** — 在两类经营异常旁开始只读调查，保留引用证据、条件方案、串行复核和历史。补货方案明确到货前缺口；预算方案不承诺提升 ROAS。交付独立只读 MCP 与三份版本化 Skill。

- **决策草稿与证据导出** — 桌面调查通过MCP读取冻结证据和Skill，支持Markdown/JSON报告下载。方案可保存为版本化草稿，核对前后值并提交本地模拟审批；快照变化、缺证、过期和版本冲突会阻断。审批处理已接入本地模拟审批中心，业务执行尚未接入。

- **本地模拟审批中心** — 查看具体版本和动作前后值，填写理由批准或驳回；修订、过期与证据变化会使旧批准失效，保留原结论及审计并支持重启恢复。仅单用户模拟角色，批准不会自动执行，可另行确认本地模拟动作。

- **本地模拟执行与回执核对** — 批准后核对具体版本并确认执行到隔离的模拟账本，支持商家券、预算与待受理补货请求。执行前复核审批、证据、时效和目标版本，重复请求返回原成功回执，失败回滚并保留尝试。可重新回读核对并在重启后查看历史；提供明确标注的1天交期补货演示，不修改真实经营系统或原始快照。

- **补偿申请与重新审批** — 从成功模拟回执发起恢复申请，核对当前目标版本、证据和约束，填写理由重新批准或驳回。修订使旧批准失效，执行保留独立回执、回读与历史；后续修改、过期或低毛利恢复会被阻断。仅取消本地未受理补货请求，不直接修改库存或真实经营系统。

- **执行批次与待确认恢复** — 将同店铺、渠道的独立已批准模拟动作编组，逐项保留回执；部分成功时只重试确认失败项。进程中断后显示结果待确认，先查询本地原子账本并阻断旧进程，确认结果后才可继续，恢复历史支持重启和导出。

## Improvements

- **库存与广告规则** — 补充相邻等长窗口的销量、库存覆盖与 ROAS 分析，支持两种 CSV 模板、列映射、错误行隔离、质量报告、不可变历史和统一异常中心。归因不一致及关键缺数显示待补证；两类预警现在可以进入只读调查；审批支持本地模拟处理，经营执行尚未接入。

- **Windows 顶栏** — 移除额外的系统标题条，将原生窗口按钮融入应用顶栏，保留拖动、调整窗口和关闭能力。

## Bug Fixes

- **调查格式稳定性** — 明确报告引用数组结构，复核格式错误可有界纠正一次；仍失败时显示阶段和字段，保留已有证据，禁止无效报告进入完成状态。

## Breaking Changes

- **Restore desktop workspace** — Keep the original desktop shell as the startup experience. Open retail analysis from its sidebar, with shared themes and panel styling instead of a separate dashboard shell.
