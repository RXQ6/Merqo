import {test,expect} from 'bun:test';
import {fetchDoudianOrderPage} from './doudian-client';
const credentials={appKey:'fixture-app',appSecret:'fixture-secret',accessToken:'fixture-token'};
const query={update_time_start:1700000000,update_time_end:1700000100};
const page={page:0,size:50,total:1,shop_order_list:[{opaque_fixture_id:'order-1',unmapped:'not a financial event'}]};
function transport(response:Response):typeof fetch{return Object.assign(async()=>response,{preconnect:()=>{}}) as typeof fetch;}

test('explicit readonly page transport validates official endpoint and signed body without inferring business events',async()=>{
 let calls=0;
 const mock=Object.assign(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{calls++;expect(new URL(String(url)).origin).toBe('https://openapi-fxg.jinritemai.com');expect(new URL(String(url)).pathname).toBe('/order/searchList');expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error');expect(JSON.parse(String(init?.body)).page).toBe(0);return Response.json({code:10000,data:page});},{preconnect:()=>{}}) as typeof fetch;
 const result=await fetchDoudianOrderPage(query,credentials,{fetch:mock,now:()=>1700000200000});
 expect(calls).toBe(1);expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected page');
 expect(result.orders).toEqual(page.shop_order_list);expect(result.audit.status).toBe('received_unmapped');expect(result.audit.count).toBe(1);expect(result.audit.responseSha256).toHaveLength(64);
 expect(JSON.stringify(result.audit)).not.toContain(credentials.accessToken);expect(JSON.stringify(result.audit)).not.toContain(credentials.appSecret);expect(JSON.stringify(result.audit)).not.toContain('not a financial event');
});
test('HTTP errors, platform failures and malformed pages never advance a page or leak response details',async()=>{
 for(const status of[401,403,429,500,502,503,504]){
  const result=await fetchDoudianOrderPage(query,credentials,{fetch:transport(new Response('fixture-token fixture-secret',{status}))});
  expect(result).toMatchObject({ok:false,kind:'http',httpStatus:status,retryable:[429,502,503,504].includes(status)});
  expect(JSON.stringify(result)).not.toContain(credentials.accessToken);expect(JSON.stringify(result)).not.toContain(credentials.appSecret);
 }
 for(const body of[{code:40004,msg:credentials.accessToken},{code:10000},{code:10000,data:{...page,page:1}},{code:10000,data:{...page,size:100}},{code:10000,data:{...page,total:0}},{code:10000,data:{...page,shop_order_list:[null]}},{code:'10000',data:page}]){
  const result=await fetchDoudianOrderPage(query,credentials,{fetch:transport(Response.json(body))});expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain(credentials.accessToken);
 }
 const invalid=await fetchDoudianOrderPage(query,credentials,{fetch:transport(new Response('<html>not JSON</html>'))});expect(invalid).toMatchObject({ok:false,kind:'invalid_response',retryable:false});
});
test('transport failures and caller cancellation remain explicit; no automatic retries',async()=>{
 let calls=0;const failing=Object.assign(async()=>{calls++;throw Error(credentials.accessToken);},{preconnect:()=>{}}) as typeof fetch;
 expect(await fetchDoudianOrderPage(query,credentials,{fetch:failing})).toMatchObject({ok:false,kind:'transport',retryable:true});
 const controller=new AbortController();controller.abort();expect(await fetchDoudianOrderPage(query,credentials,{fetch:failing,signal:controller.signal})).toMatchObject({ok:false,kind:'cancelled',retryable:false});
 expect(calls).toBe(1);
});
test('request deadline aborts the read instead of reporting an empty successful page',async()=>{
 const waiting=Object.assign(async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
  if(init?.signal?.aborted){reject(Error('aborted'));return;}
  init?.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
 }),{preconnect:()=>{}}) as typeof fetch;
 expect(await fetchDoudianOrderPage(query,credentials,{fetch:waiting,timeoutMs:5})).toMatchObject({ok:false,kind:'transport',retryable:true});
});
