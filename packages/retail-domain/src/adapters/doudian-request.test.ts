import {test,expect,spyOn} from 'bun:test';
import {prepareDoudianOrderRequest,DoudianOrderQuerySchema} from './doudian-request';
const secrets={appKey:'fixture-app',appSecret:'fixture-secret',accessToken:'fixture-token'};

test('offline order plan fixes the read method, official host, page origin, sorted JSON and signature transport',()=>{
 const actual=prepareDoudianOrderRequest({update_time_start:1700000000,update_time_end:1700000100},secrets,1700000200);
 expect(actual.body).toBe('{"order_asc":true,"order_by":"update_time","page":0,"size":50,"update_time_end":1700000100,"update_time_start":1700000000}');
 const url=new URL(actual.url);expect(url.origin).toBe('https://openapi-fxg.jinritemai.com');expect(url.pathname).toBe('/order/searchList');expect(url.searchParams.get('method')).toBe('order.searchList');expect(url.searchParams.has('param_json')).toBe(false);expect(url.searchParams.get('sign_method')).toBe('hmac-sha256');
 // Synthetic golden HMAC independently generated with .NET HMACSHA256, not an official platform test vector.
 expect(url.searchParams.get('sign')).toBe('78113e5c21597d8e3947ee53dbd478b4affd065a83e4c5beb7d1f7f89a993eda');
 expect(actual.method).toBe('POST');expect(actual.audit.status).toBe('prepared_offline');
 expect(actual.url).not.toContain(secrets.appSecret);expect(JSON.stringify(actual.audit)).not.toContain(secrets.accessToken);expect(JSON.stringify(actual.audit)).not.toContain(secrets.appSecret);
 const reordered=prepareDoudianOrderRequest({size:50,page:0,update_time_end:1700000100,update_time_start:1700000000},secrets,1700000200);expect(reordered).toEqual(actual);
 const next=prepareDoudianOrderRequest({page:1,update_time_start:1700000000,update_time_end:1700000100},secrets,1700000200);expect(new URL(next.url).searchParams.get('sign')).not.toBe(url.searchParams.get('sign'));
});
test('preparation accepts only the bounded read contract, rejects missing authorization material and never starts network I/O',()=>{
 const network=spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('Network forbidden in offline preparation');});
 try{
 for(const query of [{update_time_start:2,update_time_end:1},{update_time_start:1,update_time_end:2,size:101},{update_time_start:1,update_time_end:2,page:-1},{update_time_start:1,update_time_end:2,method:'product.editV2'},{update_time_start:1,update_time_end:2,order_by:'create_time'}])expect(DoudianOrderQuerySchema.safeParse(query).success).toBe(false);
 expect(()=>prepareDoudianOrderRequest({update_time_start:1,update_time_end:2},{...secrets,accessToken:''},1700000200)).toThrow();
 expect(()=>prepareDoudianOrderRequest({update_time_start:1,update_time_end:2},secrets,1.5)).toThrow();
 prepareDoudianOrderRequest({update_time_start:1,update_time_end:2},secrets,1700000200);expect(network).not.toHaveBeenCalled();
 }finally{network.mockRestore();}
});
