import { mkdirSync, writeFileSync } from 'node:fs';
import { ADS_DEMO, INVENTORY_DEMO, previewSignals } from '../packages/retail-domain/src/signals';
const root = new URL('../fixtures/retail/', import.meta.url); mkdirSync(root, { recursive: true });
const csv = (r: object) => Object.keys(r).join(',') + '\n' + Object.values(r).map(v => v ?? '').join(',');
const inv = previewSignals('inventory', INVENTORY_DEMO).valid[0]!;
const ads = previewSignals('ads', ADS_DEMO).valid[0]!;
for (const [name, content] of Object.entries({
  'inventory-demo.csv': INVENTORY_DEMO, 'ads-demo.csv': ADS_DEMO,
  'inventory-errors.csv': csv(inv) + '\n' + csv(inv).split('\n')[1] + '\n' + csv({ ...inv, reserved: 999 }).split('\n')[1],
  'inventory-corrected.csv': csv({ ...inv, recent_sales_qty: 210, on_hand: 1000, inbound_qty: 0, inbound_eta: null }),
  'ads-errors.csv': csv(ads) + '\n' + csv(ads).split('\n')[1] + '\n' + csv({ ...ads, currency: 'USD' }).split('\n')[1],
  'ads-corrected.csv': csv({ ...ads, attributed_revenue_minor: 400000 }),
})) writeFileSync(new URL(name, root), '\uFEFF' + content, 'utf8');
