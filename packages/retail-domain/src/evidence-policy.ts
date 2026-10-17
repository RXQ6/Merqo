/** Synthetic replay does not become stale with wall-clock age. Never rewrite its import history. */
export function evidenceTimeIssue(evidence: {source: 'demo' | 'csv'; importedAt: string}, now = Date.now()): string | null {
  const age = now - Date.parse(evidence.importedAt);
  if (!Number.isFinite(age) || age < -300000) return '证据导入时间无效或超前，请检查本机时间并重新载入数据';
  if (evidence.source !== 'demo' && age > 86400000) return '经营证据导入超过24小时，请更新证据并重新调查';
  return null;
}
