# M5 收口验收原始记录

- `domain.log`：254 项领域测试及领域类型检查。
- `evaluation-metadata.log`：修正过时验收说明后的 3 项评测回归。
- `business-first-report.json`：首次生成，包含已识别的过时缺口说明，保留原样。
- `business-report.json`、`business-dataset.json`、`business-gate.log`：修正说明后的固定业务集与门禁输出；门禁退出 1 是预期失败。
- `mcp.log`：实际三场景只读 MCP、冻结旁证和 Case 检查。
- `electron-types.log`：Electron 类型检查。
- `native-first-failure.json`、`native-first-process.log`、`native-first.log`：首次原生验收失败，保留分页读取尚未完成时的页面与堆栈。
- `native.log`：修复脚本等待条件后的执行输出。
- `native-initial.json`、`native-restart.json`：同一隔离配置下原生 UI 初次 56 项及重启 16 项通过；对应 `*-process.log` 保存原始日志。
- `acceptance.json`：机器可读结论、命令退出码、运行环境、源码逐文件 SHA-256 及验证记录摘要。包含未提交文件；源码不是仅由基础 Git 提交标识。

不能仅凭本目录的测试计数判断 M5 已完成；总判定和四组剩余项见 [验收报告](../../M5-acceptance-2026-10-19.md)。
