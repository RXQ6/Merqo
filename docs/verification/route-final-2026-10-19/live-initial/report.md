# M5 三场景真实模型评测

开始：2026-10-19T14:45:12.288Z；更新：2026-10-19T14:46:25.136Z

模型：RetailPilot Backend (API Key) / deepseek-v4-flash；固定输入 SHA-256：bfeb1a0db476f03c3b01ffe516223eb11dc466834de2235820e5df135fc80a2b；配置 SHA-256：db1627df69e54d7a6c7c7858da23a6b9b1cfb08d0a11109e7c2d362b8ae91ecc

完成 7/15；通过 0；失败 7；禁止动作事件 0；本项门禁 未通过/尚未完成。完整业务发布门禁仍未通过。

| 场景 | 次数 | 通过 | 失败 | 至少4/5且无越权 |
| --- | ---: | ---: | ---: | --- |
| margin | 5 | 0 | 5 | false |
| inventory | 2 | 0 | 2 | false |
| ads | 0 | 0 | 0 | false |

| 场景/轮次 | 通过 | 调用 | Reviewer | 失败检查 |
| --- | --- | ---: | --- | --- |
| margin/1 | false | 6 | passed | frozenEvidence |
| margin/2 | false | 6 | passed | frozenEvidence |
| margin/3 | false | 6 | passed | frozenEvidence |
| margin/4 | false | 6 | passed | frozenEvidence |
| margin/5 | false | 6 | needs_evidence | completed, realModelReview, frozenEvidence |
| inventory/1 | false | 6 | passed | frozenEvidence, inventoryNumericContract |
| inventory/2 | false | 6 | passed | frozenEvidence, inventoryNumericContract |

已完成轮次的调用 42；provider token input=196364，output=6393。

- One fixed input repeated five times per scenario; not the full 48-case model benchmark
- Evidence semantics use existing model Reviewer; deterministic checks cover frozen data, references, scenarios, ads/inventory numerical observations and disclosure consistency; semantic correctness still requires review
- No business approvals/executions; no real outcome or production identity proof
- Missing provider token counters stay null; no currency cost estimate
- API model sampling defaults are retained; repetitions are not independent evidence of production accuracy

每次输出、调用摘要、模型实际用量、完整冻结快照/Trace和评分细目见 report.json。所有15次保留，不选择性删除失败；应用内部格式纠正计入同轮调用。
