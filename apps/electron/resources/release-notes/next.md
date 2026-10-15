# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **RetailPilot 促销毛利工作台** — 演示快照、CSV 映射预览与错误行隔离、确定性毛利预警、证据详情和导出，支持 SQLite 批次历史、重复导入与重启恢复。

- **促销毛利调查** — 在异常商品旁开始只读调查，查看引用证据、原因假设、两个方案的代码测算和串行复核。支持 API 连接及明确标注的离线规则演示，调查记录重启后保留；审批与业务执行尚未接入。

- **RetailPilot M0 foundation** — Independent desktop identity and local data, disabled unconfigured upstream sharing and updates, and initial retail domain contracts. Business investigation and execution follow in later milestones.

## Improvements

- **库存与广告规则** — 补充相邻等长窗口的销量、库存覆盖与 ROAS 分析，支持两种 CSV 模板、列映射、错误行隔离、质量报告、不可变历史和统一异常中心。归因不一致及关键缺数显示待补证；本轮不包含两场景的 Agent 调查。

- **Windows 顶栏** — 移除额外的系统标题条，将原生窗口按钮融入应用顶栏，保留拖动、调整窗口和关闭能力。

## Bug Fixes

## Breaking Changes

- **Restore desktop workspace** — Keep the original desktop shell as the startup experience. Open retail analysis from its sidebar, with shared themes and panel styling instead of a separate dashboard shell.
