/** Test-only fixture: real domain imports with completed synthetic business windows.
 * No production clock changes and no arbitrary renderer import of demo data. */
import {join} from 'node:path';import {RetailStore} from '../packages/retail-domain/src/store';import {SignalStore} from '../packages/retail-domain/src/signal-store';
import {DEMO_CSV} from '../packages/retail-domain/src/operations';import {ADS_DEMO,INVENTORY_EXECUTION_DEMO} from '../packages/retail-domain/src/signals';
const root=process.argv[2];if(!root)throw Error('Missing isolated test workspace');
const shift=(csv:string)=>csv.replace(/\d{4}-\d{2}-\d{2}/g,date=>new Date(Date.parse(date+'T00:00:00Z')-7*86400000).toISOString().slice(0,10));
const file=join(root,'retail','operations.sqlite'),data=new RetailStore(file),signals=new SignalStore(file+'.signals.sqlite');try{data.import(shift(DEMO_CSV),undefined,'demo');signals.import('inventory',shift(INVENTORY_EXECUTION_DEMO),undefined,'demo');signals.import('ads',shift(ADS_DEMO),undefined,'demo');console.log(JSON.stringify({ok:true,source:'builtin_synthetic',businessEnd:'2026-10-07',observationEnd:'2026-10-14',clockChanged:false}));}finally{signals.close();data.close();}
