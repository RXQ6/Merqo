import {useEffect,useRef,useState} from 'react';
import {Boxes, ChartNoAxesCombined, ChevronDown, CircleAlert, ClipboardCheck, FileSearch, FileSpreadsheet, LayoutDashboard, ListChecks, MessagesSquare, PanelLeftClose, PanelLeftOpen, RotateCcw, Search, Settings2, ShieldCheck, ShoppingBag, Star, Truck, X} from 'lucide-react';
import {Dialog,DialogContent,DialogHeader,DialogTitle} from '../components/ui/dialog';
import './retail-navigation.css';

export type RetailPage = 'morning' | 'products' | 'overview' | 'anomalies' | 'inventory' | 'ads' | 'transactions' | 'assistant' | 'tasks' | 'investigations' | 'checks' | 'decisions' | 'approvals' | 'executions' | 'compensations' | 'batches' | 'reviews' | 'connections' | 'catalog' | 'data' | 'policy' | 'entities' | 'followups' | 'knowledge';
type Entry={id:RetailPage;label:string;icon:typeof Boxes;keywords:string};
export const retailGroups=[
  {id:'business',label:'经营总览',icon:LayoutDashboard,items:[
    {id:'morning',label:'经营晨会',icon:LayoutDashboard,keywords:'今天 每日 早报 到期 待补证'},
    {id:'products',label:'商品经营档案',icon:Boxes,keywords:'商品 时间线 备注 历史 档案'},
    {id:'overview',label:'总览',icon:LayoutDashboard,keywords:'经营总览 商品毛利 收入 成本'},
    {id:'inventory',label:'库存与补货',icon:Boxes,keywords:'缺货 采购 仓库 调拨 盘点'},
    {id:'ads',label:'广告经营',icon:ChartNoAxesCombined,keywords:'投放 ROAS 归因'},
    {id:'transactions',label:'交易与退款',icon:ShoppingBag,keywords:'订单 售后 结算'},
  ]},
  {id:'investigation',label:'异常与调查',icon:CircleAlert,items:[
    {id:'anomalies',label:'异常中心',icon:CircleAlert,keywords:'预警 风险 补证'},
    {id:'entities',label:'业务实体',icon:Boxes,keywords:'店铺 商品 SKU 规格'},
    {id:'investigations',label:'调查记录',icon:FileSearch,keywords:'证据 报告 分析'},
    {id:'checks',label:'经营巡检',icon:ListChecks,keywords:'检查 自动巡检'},
  ]},
  {id:'tasks',label:'任务与决策',icon:ListChecks,items:[
    {id:'tasks',label:'业务任务',icon:ListChecks,keywords:'跟进 待办 负责人 截止'},
    {id:'followups',label:'复查与提醒',icon:ClipboardCheck,keywords:'逾期 到期 周期'},
    {id:'decisions',label:'决策草稿',icon:FileSpreadsheet,keywords:'方案 比较'},
    {id:'approvals',label:'审批中心',icon:ShieldCheck,keywords:'批准 驳回 审核'},
    {id:'executions',label:'执行记录',icon:Truck,keywords:'模拟 回执'},
    {id:'compensations',label:'补偿记录',icon:RotateCcw,keywords:'回滚 失败处理'},
  ]},
  {id:'knowledge',label:'知识与复盘',icon:FileSearch,items:[
    {id:'knowledge',label:'经营知识中心',icon:FileSearch,keywords:'wiki 知识库 文档 方法 专题 案例'},
    {id:'reviews',label:'经营复盘',icon:ClipboardCheck,keywords:'效果 观察 经验'},
  ]},
  {id:'settings',label:'数据与设置',icon:Settings2,items:[
    {id:'connections',label:'平台接入',icon:Settings2,keywords:'同步 连接 授权 抖店 备份 恢复'},
    {id:'data',label:'数据与导入',icon:FileSpreadsheet,keywords:'csv 模板 导入'},
    {id:'catalog',label:'商品映射',icon:Boxes,keywords:'商品目录 成本映射'},
    {id:'policy',label:'经营规则',icon:Settings2,keywords:'口径 阈值 配置'},
  ]},
] satisfies Array<{id:string;label:string;icon:typeof Boxes;items:Entry[]}>;
type Group=typeof retailGroups[number];
const assistant:Entry={id:'assistant',label:'经营助手',icon:MessagesSquare,keywords:'AI 问答 智能助手'};
const batches:Entry={id:'batches',label:'批量执行',icon:Truck,keywords:'执行批次 批量任务'};
const entries:Entry[]=[...retailGroups.flatMap<Entry>(g=>g.items),assistant,batches];
const entry=(page:RetailPage)=>entries.find(i=>i.id===page)!;
export const retailGroupFor=(page:RetailPage):Group|undefined=>retailGroups.find(g=>g.items.some(i=>i.id===(page==='batches'?'executions':page)));

export function useRetailNavigationPreferences(workspaceId:string){
  const [compact,setCompact]=useState(()=>window.matchMedia('(max-width:950px)').matches),[manualCollapsed,setManualCollapsed]=useState<boolean|null>(null);
  const key='merqo:retail-favorites:v1:'+workspaceId;
  const [favorites,setFavorites]=useState<RetailPage[]>(()=>{try{const saved=JSON.parse(localStorage.getItem(key)??'null');if(Array.isArray(saved))return [...new Set(saved.filter((id):id is RetailPage=>typeof id==='string'&&entries.some(i=>i.id===id&&i.id!=='assistant')))].slice(0,5);}catch{/* A broken preference must not prevent opening the workspace. */}return ['tasks','inventory'];});
  const [preferenceNotice,setPreferenceNotice]=useState('');
  useEffect(()=>{const media=window.matchMedia('(max-width:950px)');const changed=()=>setCompact(media.matches);media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);},[]);
  function toggleFavorite(page:RetailPage){if(page==='assistant')return;if(!favorites.includes(page)&&favorites.length>=5){setPreferenceNotice('常用入口最多5项，请先移除一个。');return;}const next=favorites.includes(page)?favorites.filter(i=>i!==page):[...favorites,page];setFavorites(next);try{localStorage.setItem(key,JSON.stringify(next));setPreferenceNotice('');}catch{setPreferenceNotice('常用入口已在本次窗口生效，暂时无法保存到本机。');}}
  return{favorites,toggleFavorite,collapsed:manualCollapsed??compact,toggleCollapsed:()=>setManualCollapsed(!(manualCollapsed??compact)),preferenceNotice};
}
export type NavigationPreferences=ReturnType<typeof useRetailNavigationPreferences>;
type Props={page:RetailPage;warnings:number;onNavigate:(page:RetailPage)=>void;preferences:NavigationPreferences;active:boolean};
export function RetailNavigation({page,warnings,onNavigate,preferences,active}:Props){
  const group=retailGroupFor(page),lastVisited=useRef<Record<string,RetailPage>>({}),[searchOpen,setSearchOpen]=useState(false),[query,setQuery]=useState('');
  useEffect(()=>{if(group)lastVisited.current[group.id]=page;},[page,group]);
  useEffect(()=>{if(!active){setSearchOpen(false);return;}const keydown=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='k'){event.preventDefault();event.stopPropagation();setSearchOpen(true);}};window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown);},[active]);
  const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean),matches=entries.filter(i=>words.every(w=>`${i.label} ${i.keywords} ${retailGroupFor(i.id)?.label??''}`.toLowerCase().includes(w)));
  const resultsRef=useRef<HTMLUListElement>(null);
  function go(next:RetailPage){setSearchOpen(false);setQuery('');onNavigate(next);}
  return <><aside className="retail-navigation retail-navigation-short" aria-label="业务导航栏">
    <div className="retail-navigation-tools"><button className="retail-nav-search" title="搜索功能（Ctrl+K）" aria-label="打开功能搜索" onClick={()=>setSearchOpen(true)}><Search size={17}/><span>搜索功能</span><kbd>⌃K</kbd></button><button className="retail-nav-collapse" aria-label={preferences.collapsed?'展开导航栏':'收起导航栏'} title={preferences.collapsed?'展开导航栏':'收起导航栏'} onClick={preferences.toggleCollapsed}>{preferences.collapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}</button></div>
    <nav aria-label="经营导航">{retailGroups.map(g=>{const Icon=g.icon;return <button key={g.id} aria-label={g.label} title={g.label} aria-current={group?.id===g.id?'page':undefined} onClick={()=>{if(group?.id!==g.id)go(lastVisited.current[g.id]??g.items[0]!.id);}}><Icon size={18} aria-hidden="true"/><span className="retail-nav-label">{g.label}</span>{g.id==='investigation'&&warnings>0&&<span aria-label={`${warnings}条已加载范围的异常或待补证`} title="当前已加载经营范围的异常及待补证计数" className="retail-nav-count">{warnings}</span>}</button>;})}</nav>
    <div className="retail-nav-assistant"><button aria-label="经营助手" title="经营助手" aria-current={page==='assistant'?'page':undefined} onClick={()=>go('assistant')}><MessagesSquare size={18}/><span className="retail-nav-label">经营助手</span></button></div>
    <section className="retail-nav-favorites" aria-label="常用入口"><h2>常用入口 <span>{preferences.favorites.length}/5</span></h2>{preferences.favorites.map(id=>{const i=entry(id),Icon=i.icon;return <div className="retail-nav-favorite" key={id}><button aria-label={'常用：'+i.label} title={i.label} onClick={()=>go(id)}><Icon size={15}/><span>{i.label}</span></button><button className="retail-nav-unpin" aria-label={'取消常用：'+i.label} title="移除常用入口" onClick={()=>preferences.toggleFavorite(id)}><X size={13}/></button></div>;})}{!preferences.favorites.length&&<p>在页面顶部点击星标，加入常用。</p>}</section>
    <p className="retail-navigation-note">本地经营工作台<br/><span>审批与执行使用模拟账本</span></p>
  </aside>
  <Dialog open={searchOpen} onOpenChange={open=>{setSearchOpen(open);if(!open)setQuery('');}}><DialogContent className="retail-function-dialog" aria-describedby={undefined}><DialogHeader><DialogTitle>查找经营功能</DialogTitle></DialogHeader><label className="retail-function-query">功能名称或业务问题<input aria-label="搜索经营功能" autoFocus value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&matches[0]){e.preventDefault();go(matches[0].id);}if(e.key==='ArrowDown'){e.preventDefault();resultsRef.current?.querySelector<HTMLButtonElement>('button')?.focus();}}} placeholder="例如：审批、缺货、Wiki、备份"/></label><ul ref={resultsRef} aria-label="功能搜索结果" className="retail-function-results">{matches.map(i=>{const Icon=i.icon;return <li key={i.id}><button onClick={()=>go(i.id)}><Icon size={18}/><span><strong>{i.label}</strong><small>{retailGroupFor(i.id)?.label??'经营助手'}</small></span></button></li>;})}</ul>{!matches.length&&<p role="status">没有找到相关功能，试试“库存”“调查”或“Wiki”。</p>}<p className="retail-function-hint">输入后按 Enter 打开首项，按 Esc 返回。</p></DialogContent></Dialog>
  </>;
}

export function RetailSecondaryNavigation({page,warnings,onNavigate,preferences}:Omit<Props,'active'>){
  const group=retailGroupFor(page),[capacity,setCapacity]=useState(6),[moreOpen,setMoreOpen]=useState(false),container=useRef<HTMLElement>(null),menu=useRef<HTMLDivElement>(null),moreButton=useRef<HTMLButtonElement>(null),moreWrap=useRef<HTMLDivElement>(null);
  const items:Entry[]=group?.items??[],activePage=page==='batches'?'executions':page;
  const visible=items.slice(0,capacity);if(!visible.some(i=>i.id===activePage)&&items.some(i=>i.id===activePage))visible[visible.length-1]=items.find(i=>i.id===activePage)!;
  const hidden=items.filter(i=>!visible.some(v=>v.id===i.id));
  useEffect(()=>{const el=container.current;if(!el)return;const observer=new ResizeObserver(([e])=>{if(e)setCapacity(e.contentRect.width>=880?6:e.contentRect.width>=650?4:e.contentRect.width>=430?3:2);});observer.observe(el);return()=>observer.disconnect();},[]);
  useEffect(()=>setMoreOpen(false),[page,capacity]);
  useEffect(()=>{if(!moreOpen)return;menu.current?.querySelector<HTMLButtonElement>('button')?.focus();const outside=(e:PointerEvent)=>{if(!moreWrap.current?.contains(e.target as Node))setMoreOpen(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[moreOpen]);
  return <header className="retail-secondary-navigation" aria-label="当前业务导航"><div className="retail-navigation-context"><p><span>{group?.label??'经营助手'}</span><span aria-hidden="true">/</span><strong>{entry(page).label}</strong></p>{page!=='assistant'&&<button className="retail-nav-pin" aria-label={preferences.favorites.includes(page)?'取消收藏当前功能':'收藏当前功能'} aria-pressed={preferences.favorites.includes(page)} onClick={()=>preferences.toggleFavorite(page)}><Star size={15} fill={preferences.favorites.includes(page)?'currentColor':'none'}/><span>{preferences.favorites.includes(page)?'已加入常用':'加入常用'}</span></button>}</div>
    <nav aria-label="业务功能导航" ref={container}>{visible.map(i=><button key={i.id} aria-current={activePage===i.id?'page':undefined} onClick={()=>{if(activePage!==i.id)onNavigate(i.id);}}>{i.label}{i.id==='anomalies'&&warnings>0&&<span className="retail-nav-count">{warnings}</span>}</button>)}{hidden.length>0&&<div className="retail-nav-more" ref={moreWrap}><button ref={moreButton} aria-label="更多业务功能" aria-haspopup="menu" aria-expanded={moreOpen} onClick={()=>setMoreOpen(v=>!v)} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setMoreOpen(true);}}}>更多<ChevronDown size={14}/></button>{moreOpen&&<div role="menu" aria-label="更多业务功能列表" ref={menu} onKeyDown={e=>{const buttons=Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]')??[]),index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setMoreOpen(false);moreButton.current?.focus();}if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}}}>{hidden.map(i=><button role="menuitem" key={i.id} onClick={()=>{setMoreOpen(false);onNavigate(i.id);}}>{i.label}</button>)}</div>}</div>}</nav>{preferences.preferenceNotice&&<p className="retail-nav-preference-notice" role="status">{preferences.preferenceNotice}</p>}
  </header>;
}
