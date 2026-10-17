import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { BUSINESS_CASES, FAULT_CASES, PROTOCOL_FIXTURES } from '../packages/retail-domain/src/evaluation/catalog';
import { runBusinessEvaluation } from '../packages/retail-domain/src/evaluation/runner';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--release-gate')) throw new Error('Usage: bun run retail:eval [--release-gate]');
const root = resolve(import.meta.dir, '..');
const output = join(root, 'artifacts', 'business-eval'); mkdirSync(output, { recursive: true });
const report = await runBusinessEvaluation();
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(output, 'dataset.json'), JSON.stringify({ version: report.version, datasetHash: report.datasetHash, cases: [...BUSINESS_CASES, ...FAULT_CASES], protocolFixtures: PROTOCOL_FIXTURES }, null, 2) + '\n');
const escape = (v: unknown) => String(v).replaceAll('|', '\\|').replaceAll('\n', ' ');
const md = [
  '# M5 固定业务样例评测', '',
  `运行：${report.startedAt}；数据集 SHA-256：${report.datasetHash}`, '',
  `总数 ${report.summary.total}；通过 ${report.summary.passed}；失败 ${report.summary.failed}；未支持 ${report.summary.unsupported}。`, '',
  '**发布门禁未通过。** 通过仅代表该固定合成样例的领域断言通过，不代表真实模型质量、线上准确率或业务效果。', '',
  '审批执行准备使用明确标记的本地 Reviewer 协议夹具，不调用外部模型。UNKNOWN 使用可恢复的合成时钟偏移；不代表实际网络超时/进程崩溃已验证。', '',
  '## 检测器混淆矩阵', '',
  '仅包含实际运行的毛利/库存/广告检测。补证、隔离、策略拒绝分别记录；未支持项不计为正常样本。', '',
  '| 期望 \\ 实际 | normal | warning | needs_evidence | rejected | execution_error |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...Object.entries(report.detectorMatrix).map(([key, row]) => `| ${key} | ${Object.values(row).join(' | ')} |`), '',
  `正常/预警子集：TP=${report.warningConfusion.truePositive}，FP=${report.warningConfusion.falsePositive}，FN=${report.warningConfusion.falseNegative}，TN=${report.warningConfusion.trueNegative}；补证、隔离或运行错误排除 ${report.warningConfusion.excluded} 例。不得外推真实检测准确率。`, '',
  '## 逐例结果', '', '| 样例 | 结果 | 期望 | 实际 |', '| --- | --- | --- | --- |',
  ...report.results.map(r => `| ${r.id} | ${r.status} | ${escape(r.expected)} | ${escape(r.actual)} |`), '',
  '原始输入、规则、允许结论、必需证据、禁止动作见 dataset.json；逐例冻结记录、工具证据、拒绝理由、回执和对账见 report.json。', '',
  '## 尚待验收', '', ...report.remainingGates.map(g => `- ${g}`), '',
  '多规格仅验证快照内部冲突，SKU错配仅验证工具与冻结身份一致；异常销量仅覆盖相邻窗口下降，不证明外部目录匹配、销量暴涨或原因识别。', '',
].join('\n');
writeFileSync(join(output, 'report.md'), md);
console.log(JSON.stringify({ ...report.summary, releaseReady: report.releaseReady, report: join(output, 'report.md') }, null, 2));
process.exitCode = report.summary.failed > 0 || (args.includes('--release-gate') && !report.releaseReady) ? 1 : 0;
