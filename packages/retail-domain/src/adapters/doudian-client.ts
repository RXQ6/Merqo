/** Server/worker only. Explicit single-page read; no token acquisition, persistence or ledger writes. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {prepareDoudianOrderRequest,type DoudianCredentials,type DoudianOrderQuery} from './doudian-request';

const envelope=z.object({code:z.number().int(),data:z.unknown().optional()});
// Only transport-level fields are mapped. Order financial/event fields await real authorized samples.
const pageSchema=z.object({page:z.number().int().min(0),size:z.number().int().min(1).max(100),total:z.number().int().nonnegative().safe(),shop_order_list:z.array(z.record(z.string(),z.unknown()))});
type SafeAudit=ReturnType<typeof prepareDoudianOrderRequest>['audit'];
export type DoudianPageResult=
 |{ok:true;orders:Record<string,unknown>[];audit:Omit<SafeAudit,'status'>&{status:'received_unmapped';receivedAt:number;responseSha256:string;count:number;reportedTotal:number};page:number;size:number;reportedTotal:number}
 |{ok:false;kind:'transport'|'cancelled'|'http'|'platform'|'invalid_response';retryable:boolean;httpStatus?:number;platformCode?:number;audit:SafeAudit};

export async function fetchDoudianOrderPage(query:DoudianOrderQuery,credentials:DoudianCredentials,options:{fetch?:typeof globalThis.fetch;now?:()=>number;signal?:AbortSignal;timeoutMs?:number}={}):Promise<DoudianPageResult>{
 const now=options.now??Date.now;
 const timeoutMs=z.number().int().min(1).max(60000).parse(options.timeoutMs??15000);
 const request=prepareDoudianOrderRequest(query,credentials,Math.floor(now()/1000));
 if(options.signal?.aborted)return{ok:false,kind:'cancelled',retryable:false,audit:request.audit};
 const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
 let response:Response;
 try{response=await(options.fetch??globalThis.fetch)(request.url,{method:request.method,headers:request.headers,body:request.body,redirect:'error',signal});}
 catch{return{ok:false,kind:options.signal?.aborted?'cancelled':'transport',retryable:!options.signal?.aborted,audit:request.audit};}
 if(!response.ok)return{ok:false,kind:'http',retryable:[429,502,503,504].includes(response.status),httpStatus:response.status,audit:request.audit};
 let raw:string;
 try{raw=await response.text();}catch{return{ok:false,kind:options.signal?.aborted?'cancelled':'transport',retryable:!options.signal?.aborted,audit:request.audit};}
 let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return{ok:false,kind:'invalid_response',retryable:false,audit:request.audit};}
 const decoded=envelope.safeParse(parsed);
 if(!decoded.success)return{ok:false,kind:'invalid_response',retryable:false,audit:request.audit};
 if(decoded.data.code!==10000)return{ok:false,kind:'platform',retryable:false,platformCode:decoded.data.code,audit:request.audit};
 const result=pageSchema.safeParse(decoded.data.data);
 if(!result.success||result.data.page!==request.audit.page||result.data.size!==request.audit.size||result.data.shop_order_list.length>request.audit.size||result.data.shop_order_list.length>result.data.total)return{ok:false,kind:'invalid_response',retryable:false,audit:request.audit};
 return{ok:true,orders:result.data.shop_order_list,page:result.data.page,size:result.data.size,reportedTotal:result.data.total,audit:{...request.audit,status:'received_unmapped',receivedAt:now(),responseSha256:createHash('sha256').update(raw).digest('hex'),count:result.data.shop_order_list.length,reportedTotal:result.data.total}};
}
