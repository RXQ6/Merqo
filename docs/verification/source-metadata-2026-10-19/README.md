# 来源元数据专项验证归档

日期：2026-10-19。对象：`a4018de72bb9355c45a2e2d01e24fb04f1ca672c` 基线及本地未提交改动。不是已发布安装包。

| 命令 / 范围 | 结果 | 输出 |
| --- | --- | --- |
| `bun run retail:check` 最终运行 | 267 通过，0 失败，2035 断言；26 个文件，83.84 秒；领域类型通过 | [domain.log](domain.log) |
| 来源专项 | 4 通过，57 断言 | [source-focused.log](source-focused.log) |
| `bun run typecheck:electron` | 退出 0 | [electron-types.log](electron-types.log) |
| 主进程构建及输出验证 | 退出 0 | [main-build.log](main-build.log) |
| 渲染器构建 | 退出 0，1 分 30 秒；保留现有大 chunk 提示 | [renderer-build.log](renderer-build.log) |
| `bun run retail:check:mcp` | 退出 0，包含价格动作和替换拒绝、旁证及冻结 Case | [mcp.log](mcp.log) |
| `node scripts/merqo-source-desktop-check.cjs` | 原生 4 项通过，实际退出/重启；外部模型调用 0 | [native-result.json](native-result.json)、[native.log](native.log) |

首次全量为 265 通过、2 失败：新增测试漏传必填映射及使用旧批次 ID 查新批次。修正测试夹具后，专项与最终全量通过；原输出见 [initial-domain-failed.log](initial-domain-failed.log)。首次单独类型检查还发现新增测试显式传 `provenance: undefined` 不符合 exactOptionalPropertyTypes，已改为省略可选字段；记录见 [initial-types-failed.log](initial-types-failed.log)，最终类型通过包含在 domain.log。

来源功能、时间校验、三个导入路径、调查导出及桌面展示代码指纹见 [source-fingerprints.json](source-fingerprints.json)。原生截图/trace 保存在 result 中引用的 artifacts 路径，不把截图或协议夹具当作真实平台认证或模型质量证明。未重跑付费模型与十万行性能，也未打包或发布。

按用户要求在本项结束后停止；剩余开发见 [追踪矩阵](../../PRD-traceability.md)，本项说明见 [M5-source-metadata.md](../../M5-source-metadata.md)。
