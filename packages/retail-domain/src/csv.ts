/** RFC-style quoted fields, escaped quotes, BOM, CRLF and embedded newlines. */
export function parseCsv(input: string): string[][] {
  if (input.length > 32_000_000) throw new Error('CSV 超过 32 MB 限制');
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, endedQuote = false;
  const cell = () => { row.push(field); field = ''; endedQuote = false; };
  const record = () => { cell(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > 100001) throw new Error('最多导入 100,000 行'); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; endedQuote = true; }
      else field += ch;
    } else if (ch === '"') {
      if (field.length || endedQuote) throw new Error('CSV 引号格式错误');
      quoted = true;
    } else if (ch === ',') cell();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; record(); }
    else { if (endedQuote) throw new Error('CSV 引号后只能出现分隔符'); field += ch; }
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  if (field || row.length || endedQuote) record();
  return rows;
}
