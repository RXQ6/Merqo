# Merqo

**An AI-assisted desktop workspace for retail operations, evidence-backed investigations, and reusable business knowledge.**

**English** · [简体中文](README.zh-CN.md)

Merqo connects imported business data to anomaly investigation, evidence collection, plan comparison, tasks, local simulation approvals, follow-up reviews, and operating cases. Deterministic code calculates business metrics; AI helps explain evidence and organize qualitative recommendations.

Built with **Electron · React · TypeScript · Bun · SQLite**, based on the Craft Agents desktop codebase. The current application interface is primarily Chinese; these README files are available in both languages.

## Download

**Windows x64 preview: 0.1.0-beta.12** · Release record: October 23, 2026

[**Download the Windows installer**](https://github.com/RXQ6/Merqo/releases/download/v0.1.0-beta.12/Merqo-Setup-0.1.0-beta.12-x64.exe) · [Release notes](https://github.com/RXQ6/Merqo/releases/tag/v0.1.0-beta.12) · [SHA-256 checksums](https://github.com/RXQ6/Merqo/releases/download/v0.1.0-beta.12/SHA256SUMS.txt)

Install the application and launch **Merqo** from the desktop or Start menu. In-app update checks use this repository's GitHub Releases, including betas, and open a manual installer download.

> This is an unsigned Windows preview, validated on the current Windows 11 host. Database schema13 upgrades create a pre-migration backup. Do not open an upgraded workspace with beta.11 or earlier. See [installation and data locations](docs/windows-preview.md) and the [beta.12 acceptance record](docs/release-beta12-2026-10-23.md).

## The operating workflow

**Connect or import data → detect anomalies → investigate → add evidence → compare plans → create tasks → review and process → follow up → archive reusable cases.**

The local workflow is implemented. Approvals and execution operate in a local simulation; production platform writes and authenticated multi-user approvals remain outside the delivered scope.

| Navigation group | Main entries | What you can do |
| --- | --- | --- |
| Overview — 经营总览 | Daily briefing, product histories, margin, inventory and advertising analysis | Find today's priorities and trace a product's evidence, investigations and tasks |
| Anomalies & investigations — 异常与调查 | Anomaly center, business entities, investigation history, scheduled checks | Start scoped investigations, collect evidence and retain the reasoning history |
| Tasks & decisions — 任务与决策 | Tasks, follow-ups, drafts, approvals, execution and compensation records | Assign follow-up work and inspect versioned local simulation actions |
| Knowledge & reviews — 知识与复盘 | Knowledge center, operating reviews | Maintain Wiki knowledge, compare observations and archive operating cases |
| Data & settings — 数据与设置 | Platform setup, imports, product mappings, rules | Configure sources, review imports and maintain business definitions |

Function search (**Ctrl+K**) and favorites provide quick access across these five groups.

## beta.13 in acceptance: local procurement and fulfillment

- **库存与补货 → 财务与入库处理**: declare supplier payables, payments and refunds; review arrivals before posting stock; retain financial reviews and receipt evidence.
- **库存与补货 → 条码与波次**: maintain barcode/location labels, allocate multiple orders by earliest expiry, and verify scans before reserving the complete wave.
- **库存与补货 → 订单关联发货**: link an explicitly paid order line to reserved batches and atomically record transaction shipment and stock deduction, with local readback reviews.
- Investigations freeze scoped transaction, procurement, warehouse and finance evidence; tasks and cases retain the same evidence index.

These are local ledger records. Payment does not prove bank settlement; shipment does not prove carrier delivery; location labels do not provide separate bin-level inventory. See the [implementation and acceptance record](docs/local-business-closure-2026-10-24.md). This section describes source progress; downloads still point to the published beta.12.

## What's new in beta.12

### Editable AI morning briefings

Open **经营总览 → 经营晨会 → 生成 AI 摘要**. The configured model organizes the frozen briefing into qualitative priorities and follow-up suggestions, with references to the original items.

- Edit and save the summary while retaining the original AI text and revision history.
- Export the saved summary and its sources as TXT.
- The model receives metadata for the first twenty briefing items, excluding raw transaction records. Invalid output, unknown citations and timeouts produce a visible failure state; the rule-based briefing remains available.

![Editable AI morning briefing with original-item citations](docs/verification/enhancement-2026-10-23/brief-wide.png)

### Product profiles and explainable case reuse

Open **经营总览 → 商品经营档案** to maintain product categories and tags. In **参考经营案例**, maintain case categories, tags, anomaly types, validity dates, applicability conditions and exclusions.

Matching explains shared business scope, category, anomaly and tags, alongside relevant differences. Helpful/not-applicable feedback adjusts ranking by **+5 / −10** for the current product and case-profile version; the adjustment can be disabled. Changing a profile excludes old feedback from ranking. Disabled or expired cases remain available for maintenance but cannot be newly cited.

Historical investigation and task references retain their frozen case-profile version. Ranking scores indicate rule matches, not success probabilities or model training.

![Case matching with categories, reasons, differences and feedback](docs/verification/enhancement-2026-10-23/classification-wide.png)

## Core capabilities

| Area | Implemented capabilities | Boundary |
| --- | --- | --- |
| Business analysis | Promotion margins, stock coverage and replenishment risks, advertising ROAS and attribution checks | Missing evidence stays unknown; product gross profit is not net profit |
| Investigations | Scoped read-only MCP tools, frozen evidence, observations/hypotheses, alternative plans, Reviewer and Markdown/JSON exports | Offline rules are explicitly labeled; model failures do not silently become offline results |
| Tasks and follow-up | Owners, due dates, statuses, reminders, reviews, snapshot observations and immutable operating cases | Local scheduling requires the application to remain running |
| Knowledge center / Wiki | Markdown editing, search, version history, published knowledge citations, read-only Markdown and Feishu document-source synchronization | Source permissions and real-service authorization require separate acceptance |
| Data ingestion | CSV mapping, preview, quarantine, deduplication, source declarations and reviewed event imports | Declared source identities are not authenticated platform identities |
| Integration preparation | Configuration wizard, read-only checks, paginated sync jobs, checkpoints, pause/resume/retry and incremental windows | No real Douyin Shop is connected |
| Commerce and inventory | Transaction/refund events, declared costs, contribution comparisons, promotion/gift allocation, procurement, expiry, warehouse ledgers, transfers and FEFO planning | Local declared ledgers; no real ERP/WMS writeback |
| Simulation decisions | Versioned drafts, approvals, execution receipts, reread checks, compensation, independent batches and uncertain-outcome recovery | Single-user local simulation, not production authorization |
| Business backup | Password-encrypted business-database backup, preview and restoration into an isolated workspace | Excludes chats, model credentials and attachments; restored execution remains locked |

Detailed contracts and limits are linked in the [documentation guide](#documentation).

## Try it

1. Install Merqo, or build it from source below. Model setup can be deferred for local analysis.
2. Select **经营分析**, then use function search to open **数据与导入** and load the demonstration data.
3. Open **经营晨会** for priorities, or **异常中心** to start a margin, inventory or advertising investigation.
4. Use **运行离线规则演示** without model credentials, or configure a supported model connection in Settings and select it as the workspace/global default. AI summaries require a configured model.
5. Create a business task, record follow-up evidence, finish the task and archive a case. Return to **商品经营档案 → 参考案例与知识** to reuse the experience.
6. Open **知识与复盘 → 经营知识中心** to create Wiki content or configure a read-only document source.

The investigation adapter supports Anthropic Messages and OpenAI Chat Completions compatible endpoints with API-key, bearer-token or configured local no-auth access. Subscription OAuth and Responses-only endpoints are not supported by this adapter. DeepSeek model discovery is available through the configured connection.

Demonstration CSVs are included in [fixtures/retail](fixtures/retail), including margin, inventory, advertising, bundles, gifts and member-price examples. The application also provides downloadable templates. Demo data is synthetic and kept separate from imported data.

## Build from source

Validated development environment: **Windows 11, Bun 1.4.2, Node.js 24, Electron 39.2.7**. Install Git for Windows / Git Bash for the inherited Agent features. Initial dependency installation requires network access.

```powershell
git clone https://github.com/RXQ6/Merqo.git
cd Merqo
bun install --frozen-lockfile
bun run retail:build
bun run retail:start
```

After the first build, use `bun run retail:start` to launch again. The source launcher keeps local state under ignored `.runtime/config` and `.runtime/chromium`. Configure model credentials in the application; `.env` is not required for the analytical demos.

To create a Windows installer:

```powershell
bun run retail:dist:win
```

The package script stages an explicit runtime allowlist. Personal `.runtime` configuration, conversations, imported business data and credentials are not bundled; demonstration fixtures are synthetic.

## Validation and delivery status

The **beta.12** acceptance record reports:

| Check | Result |
| --- | --- |
| Domain regression and domain type checking | 414 tests passed; 3,759 assertions |
| Packaged Electron workflows | 25 groups passed across briefing/product flows, new enhancements, Wiki and the existing business workflow |
| Inference, tool-boundary, translation and pagination regression | 12 tests passed; 113 assertions |
| MCP | Actual stdio and frozen-evidence boundary checks passed |
| Desktop builds | Electron TypeScript checks and main/renderer builds passed |
| Windows installer | Actual beta.11→beta.12 upgrade, migration backup, same-version reinstall and uninstall passed; records and new classification retained |
| GitHub CI | Passed before merge |

[Acceptance report and screenshots](docs/verification/enhancement-2026-10-23/report.md) · [Release and installer evidence](docs/release-beta12-2026-10-23.md)

Useful development checks:

```powershell
bun run retail:check
bun run retail:check:mcp
bun run typecheck:electron
bun run retail:eval
```

The archived fixed synthetic benchmark contains **48 passing executable cases**. It is distinct from the 414-test regression suite. `bun run retail:eval --release-gate` still exits with unmet production release gates; passing local tests does not establish full PRD production readiness.

### Remaining scope

- Real-model business-quality evaluation and expanded adversarial/performance acceptance.
- Clean Windows and cross-version compatibility testing, plus installer signing.
- Authenticated platform adapters, real-service completeness, production writes/readback and multi-user authorization.
- Further accounting/fulfillment integrations and incorporation of the newer operational ledgers into Agent evidence.

Douyin Shop and Android are deferred. There is no closed-application background service. Real-platform transactions, live inventory and causal business uplift are not established by the synthetic demonstrations.

## Documentation

| Topic | Read more |
| --- | --- |
| Current release | [beta.12 release record](docs/release-beta12-2026-10-23.md) · [packaged acceptance](docs/verification/enhancement-2026-10-23/report.md) |
| Morning briefings, product histories and cases | [S0–S4](docs/experience-S0-S4-2026-10-23.md) · [beta.12 enhancements](docs/experience-enhancement-2026-10-23.md) |
| Local business workflow | [Three-batch delivery](docs/three-batch-delivery-2026-10-22.md) |
| Wiki | [W1–W3 design and delivery](docs/wiki-W1-W3-2026-10-22.md) |
| Platform preparation | [Sync jobs](docs/P1-sync-workflow-2026-10-20.md) · [reviewed ingestion](docs/P1-ingestion-workflow-2026-10-20.md) |
| Commerce and operations | [Promotion](docs/P1-promotion-eligibility-2026-10-21.md) · [procurement](docs/P1-procurement-2026-10-21.md) · [warehouse](docs/P1-warehouse-ledger-2026-10-21.md) · [FEFO](docs/P1-warehouse-picking-2026-10-21.md) |
| Backup and installation | [Backup/recovery](docs/P1-backup-recovery-2026-10-21.md) · [Windows preview](docs/windows-preview.md) |
| Evaluation and broader PRD gaps | [Business benchmark](docs/M5-business-evaluation.md) · [live-model evaluation](docs/M5-live-evaluation.md) · [operational route, dated October 20](docs/development-progress-2026-10-20.md) |

Most detailed design and acceptance documents are written in Chinese. Dated records describe their own delivery scope; use the beta.12 release record for current package status.

## Architecture

```text
React desktop UI
    → allowlisted, typed IPC
Electron main process
    → trusted workspace scope, credentials, model adapter
Bun workers + scoped read-only MCP
    → deterministic rules, versioned ledgers, evidence checks
Per-workspace SQLite
    → snapshots, investigations, tasks, Wiki and operating cases
```

Retail workspaces restrict general Agent tools to read-only access, including Auto mode. Dedicated simulation operations use their own approval flow. Use a separate ordinary workspace for coding.

Key source directories: [desktop UI](apps/electron/src/renderer/retail), [main process](apps/electron/src/main), [domain](packages/retail-domain/src), [scripts](scripts), [fixtures](fixtures/retail).

## License and attribution

Merqo derives from a **Craft Agents 0.11.4** source snapshot. Some internal paths retain the RetailPilot name; upstream 0.11.4 is not the Merqo release version. See the [upstream provenance manifest](docs/baseline/upstream-manifest.json) and [original upstream README](docs/upstream-README.md).

[Apache License 2.0](LICENSE) · [NOTICE](NOTICE) · [TRADEMARK](TRADEMARK.md). Merqo is an independent derivative project and is not an official Craft product.
