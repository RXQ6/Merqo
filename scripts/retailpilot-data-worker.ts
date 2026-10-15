import { RetailStore } from '../packages/retail-domain/src/store.ts';
import { RetailRequestSchema } from '../packages/retail-domain/src/operations.ts';
const file = process.argv[2];
if (!file) throw new Error('Missing trusted database path');
let store: RetailStore | undefined;
try {
  const request = RetailRequestSchema.parse(JSON.parse(await Bun.stdin.text()));
  store = new RetailStore(file, process.argv[3] || '当前 Workspace');
  console.log(JSON.stringify(store.request(request)));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '经营数据处理失败' }));
  process.exitCode = 1;
} finally { store?.close(); }
