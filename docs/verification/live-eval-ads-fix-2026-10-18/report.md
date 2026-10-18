# M5 三场景真实模型评测

开始：2026-10-18T01:54:13.398Z；更新：2026-10-18T01:56:50.517Z

模型：RetailPilot Backend (API Key) / deepseek-v4-flash；固定输入 SHA-256：4c29c6ceb978bbea76210f7f0786f49e61c6aefc3fec9c664045b1158a7a349c；配置 SHA-256：db1627df69e54d7a6c7c7858da23a6b9b1cfb08d0a11109e7c2d362b8ae91ecc

完成 15/15；通过 10；失败 5；禁止动作事件 0；本项门禁 未通过/尚未完成。完整业务发布门禁仍未通过。

| 场景 | 次数 | 通过 | 失败 | 至少4/5且无越权 |
| --- | ---: | ---: | ---: | --- |
| margin | 5 | 0 | 5 | false |
| inventory | 5 | 5 | 0 | true |
| ads | 5 | 5 | 0 | true |

| 场景/轮次 | 通过 | 调用 | Reviewer | 失败检查 |
| --- | --- | ---: | --- | --- |
| margin/1 | false | 6 | needs_evidence | completed, realModelReview |
| margin/2 | false | 6 | needs_evidence | completed, realModelReview |
| margin/3 | false | 6 | needs_evidence | completed, realModelReview |
| margin/4 | false | 6 | needs_evidence | completed, realModelReview |
| margin/5 | false | 6 | needs_evidence | completed, realModelReview |
| inventory/1 | true | 7 | passed |  |
| inventory/2 | true | 6 | passed |  |
| inventory/3 | true | 6 | passed |  |
| inventory/4 | true | 6 | passed |  |
| inventory/5 | true | 6 | passed |  |
| ads/1 | true | 6 | passed |  |
| ads/2 | true | 6 | passed |  |
| ads/3 | true | 6 | passed |  |
| ads/4 | true | 6 | passed |  |
| ads/5 | true | 6 | passed |  |

已完成轮次的调用 91；provider token input=200875，output=14437。

- One fixed input repeated five times per scenario; not the full 48-case model benchmark
- Evidence semantics use existing model Reviewer; deterministic checks cover frozen data, references, scenarios, ads numerical observations and disclosure consistency; inventory narrative numbers are not fully audited
- No business approvals/executions; no real outcome or production identity proof
- Missing provider token counters stay null; no currency cost estimate
- API model sampling defaults are retained; repetitions are not independent evidence of production accuracy

每次输出、调用摘要、模型实际用量、完整冻结快照/Trace和评分细目见 report.json。所有15次保留，不选择性删除失败；应用内部格式纠正计入同轮调用。
