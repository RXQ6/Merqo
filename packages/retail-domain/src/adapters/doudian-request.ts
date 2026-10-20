/** Server/worker-only preparation. No network, credential storage, token acquisition or business writes. */
import {createHash,createHmac} from 'node:crypto';
import {z} from 'zod';

// Official order.searchList contract, checked 2026-10-20:
// https://op.jinritemai.com/docs/api-docs/15/521
// HMAC + POST-body transport: https://op.jinritemai.com/docs/guide-docs/10/812
export const DoudianOrderQuerySchema=z.strictObject({
 update_time_start:z.number().int().positive().safe(),update_time_end:z.number().int().positive().safe(),
 page:z.number().int().min(0).max(10000).default(0),size:z.number().int().min(1).max(100).default(50),
 order_by:z.literal('update_time').default('update_time'),order_asc:z.literal(true).default(true),
}).refine(q=>q.update_time_start<=q.update_time_end,'开始时间不能大于截止时间');
const credentials=z.strictObject({appKey:z.string().min(1).max(128),appSecret:z.string().min(1).max(4096),accessToken:z.string().min(1).max(4096)});
export type DoudianCredentials=z.infer<typeof credentials>;
export type DoudianOrderQuery=z.input<typeof DoudianOrderQuerySchema>;

export function prepareDoudianOrderRequest(input:DoudianOrderQuery,secret:DoudianCredentials,timestamp:number){
 const query=DoudianOrderQuerySchema.parse(input);credentials.parse(secret);z.number().int().positive().safe().parse(timestamp);
 const body=JSON.stringify(Object.fromEntries(Object.entries(query).sort(([a],[b])=>a<b?-1:a>b?1:0)));
 const method='order.searchList';
 const signed=secret.appSecret+'app_key'+secret.appKey+'method'+method+'param_json'+body+'timestamp'+timestamp+'v2'+secret.appSecret;
 const sign=createHmac('sha256',secret.appSecret).update(signed,'utf8').digest('hex');
 const url=new URL('https://openapi-fxg.jinritemai.com/order/searchList');
 for(const [key,value]of Object.entries({method,app_key:secret.appKey,access_token:secret.accessToken,timestamp:String(timestamp),v:'2',sign,sign_method:'hmac-sha256'}))url.searchParams.set(key,value);
 // Only this safe descriptor may go into logs/UI/evidence. Full transport URL contains the token.
 const audit={provider:'doudian',method,page:query.page,size:query.size,updateStart:query.update_time_start,updateEnd:query.update_time_end,requestBodySha256:createHash('sha256').update(body).digest('hex'),status:'prepared_offline' as const};
 return{url:url.toString(),method:'POST' as const,headers:{'Content-Type':'application/json;charset=UTF-8'},body,audit};
}
