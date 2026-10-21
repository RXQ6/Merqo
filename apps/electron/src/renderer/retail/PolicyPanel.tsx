import {PageHeader} from './PageHeader';
import {useEffect,useRef,useState} from 'react';
import {DEFAULT_RULE_SETTINGS,RuleSettingsSchema} from '../../../../../packages/retail-domain/src/business-policy';
import type {PolicyView,RuleSettings} from '../../../../../packages/retail-domain/src/business-policy';
import type {RetailRequest,RetailReply} from '../../../../../packages/retail-domain/src/operations';

const fields=[
 {key:'marginFloorBps',label:'商品毛利下限（%）',scale:100},{key:'marginMinUnits',label:'毛利分析最少成交件数',scale:1},
 {key:'salesDropBps',label:'销量下降预警幅度（%）',scale:100},{key:'stockBufferDays',label:'补货缓冲天数',scale:1},{key:'minInventorySales',label:'库存分析最少窗口销量',scale:1},
 {key:'adsRoasDropBps',label:'ROAS下降预警幅度（%）',scale:100},{key:'minAdsClicks',label:'广告分析最少点击数',scale:1},
 {key:'inventoryWindowDays',label:'库存可比窗口天数（留空沿用数据）',scale:1},{key:'adsWindowDays',label:'广告可比窗口天数（留空沿用数据）',scale:1},
 {key:'approvalMinutes',label:'审批有效期（分钟）',scale:1},{key:'priceChangeLimitBps',label:'单次改价最大幅度（%）',scale:100},
] as const satisfies ReadonlyArray<{key:keyof RuleSettings;label:string;scale:number}>;
type Form=Record<keyof RuleSettings,string>;
const formOf=(settings:RuleSettings)=>Object.fromEntries(fields.map(f=>[f.key,settings[f.key]===null?'':String(settings[f.key]!/f.scale)])) as Form;
export function PolicyPanel({request,onChanged}:{request:(r:RetailRequest)=>Promise<RetailReply|undefined>;onChanged:()=>void}){
 const [view,setView]=useState<PolicyView|null>(null);const [shop,setShop]=useState('');const [form,setForm]=useState<Form>(()=>formOf(DEFAULT_RULE_SETTINGS));
 const [reason,setReason]=useState('');const [confirmed,setConfirmed]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;void request({op:'policy'}).then(r=>{if(!alive.current)return;if(r?.ok&&r.kind==='policy'){setView(r.data);setForm(formOf(r.data.current.defaultSettings));}else setError(r&&!r.ok?r.error:'规则配置读取失败');});return()=>{alive.current=false;};},[request]);
 function scope(value:string){setShop(value);setForm(formOf(view?.current.shops.find(s=>s.shopId===value)?.settings??view?.current.defaultSettings??DEFAULT_RULE_SETTINGS));setConfirmed(false);setNotice('');}
 async function save(){if(!view||busy||!confirmed)return;
  const values=Object.fromEntries(fields.map(f=>{const raw=form[f.key].trim();const valid=(f.scale===100?/^-?\d+(?:\.\d{1,2})?$/:/^-?\d+$/).test(raw);return[f.key,raw===''?(f.key==='inventoryWindowDays'||f.key==='adsWindowDays'?null:NaN):valid?Number((Number(raw)*f.scale).toFixed(6)):NaN];}));
  const parsed=RuleSettingsSchema.safeParse(values);if(!parsed.success){setError(parsed.error.issues.map(i=>`${fields.find(f=>f.key===i.path[0])?.label??i.path.join('.')}: ${i.message}`).join('；'));return;}
  setBusy(true);setError('');setNotice('');try{const r=await request({op:'policy_update',expectedRevision:view.current.revision,shopId:shop.trim()||null,settings:parsed.data,reason});if(!r?.ok||r.kind!=='policy')throw new Error(r&&!r.ok?r.error:'规则保存失败');if(alive.current){setView(r.data);setReason('');setConfirmed(false);setNotice(`已保存规则版本 v${r.data.current.revision}。旧报告保留，相关审批需重新调查和确认。`);onChanged();}}catch(e){if(alive.current)setError(e instanceof Error?e.message:'规则保存失败');}finally{if(alive.current)setBusy(false);}
 }
 return <section data-testid="retail-policy"><PageHeader title="经营规则配置">当前经营空间 · {view?`规则版本 v${view.current.revision}`:'读取中'}</PageHeader><div className="retail-settings-body">
 <p>当前角色：本地模拟管理员。规则影响后续计算和审批；历史报告保留原版本。默认值是演示规则，可按店铺设置完整覆盖。</p>
 {error&&<div role="alert" className="retail-alert error">{error}</div>}{notice&&<div role="status" className="retail-alert">{notice}</div>}
 <label className="retail-draft-field">适用店铺<input aria-label="规则适用店铺" value={shop} disabled={busy} onChange={e=>scope(e.target.value)} placeholder="留空：全部店铺默认；输入店铺ID：仅该店铺覆盖"/></label>
 {!!view?.current.shops.length&&<p>已有店铺覆盖：{view.current.shops.map(s=><button key={s.shopId} disabled={busy} onClick={()=>scope(s.shopId)}>{s.shopId}</button>)}</p>}
 <div className="retail-mappings">{fields.map(f=><label key={f.key}>{f.label}<input aria-label={f.label} inputMode="decimal" disabled={busy||!view} value={form[f.key]} onChange={e=>{setForm(p=>({...p,[f.key]:e.target.value}));setConfirmed(false);}}/></label>)}</div>
 <label className="retail-draft-field">变更原因<textarea aria-label="规则变更原因" rows={3} maxLength={2000} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)}/></label>
 <label><input type="checkbox" aria-label="确认更新经营规则" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/> 我已核对适用店铺和参数，确认生成新规则版本</label>
 <div className="retail-inline-actions"><button disabled={busy||!view||!confirmed||!reason.trim()} onClick={()=>void save()}>保存新规则版本</button><button disabled={busy||!view} onClick={()=>scope('')}>查看默认规则</button></div>
 <details><summary>规则变更记录</summary>{view?.history.length?view.history.map(p=><p key={p.revision}>v{p.revision} · {p.at&&new Date(p.at).toLocaleString('zh-CN')} · {p.reason} · 本地模拟管理员</p>):<p>当前沿用内置演示规则，尚无变更。</p>}</details></div></section>;
}
