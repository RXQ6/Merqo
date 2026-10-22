import { Boxes, ChartNoAxesCombined, CircleAlert, ClipboardCheck, FileSearch, FileSpreadsheet, LayoutDashboard, ListChecks, MessagesSquare, RotateCcw, Settings2, ShieldCheck, ShoppingBag, Truck } from 'lucide-react';

export type RetailPage = 'overview' | 'anomalies' | 'inventory' | 'ads' | 'transactions' | 'assistant' | 'tasks' | 'investigations' | 'checks' | 'decisions' | 'approvals' | 'executions' | 'compensations' | 'batches' | 'reviews' | 'connections' | 'catalog' | 'data' | 'policy' | 'entities' | 'followups' | 'knowledge';

const groups = [
  { title: '经营现场', items: [
    { id: 'overview', label: '经营总览', icon: LayoutDashboard },
    { id: 'anomalies', label: '异常中心', icon: CircleAlert },
    { id: 'inventory', label: '库存与补货', icon: Boxes },
    { id: 'ads', label: '广告经营', icon: ChartNoAxesCombined },
    { id: 'transactions', label: '交易与退款', icon: ShoppingBag },
  ] },
  { title: '分析与跟进', items: [
    { id: 'entities', label: '业务实体', icon: Boxes },
    { id: 'assistant', label: '经营助手', icon: MessagesSquare },
    { id: 'tasks', label: '业务任务', icon: ListChecks },
    { id: 'followups', label: '复查与提醒', icon: ClipboardCheck },
    { id: 'knowledge', label: '经营知识库', icon: FileSearch },
    { id: 'investigations', label: '调查记录', icon: FileSearch },
    { id: 'checks', label: '经营巡检', icon: ListChecks },
    { id: 'reviews', label: '经营复盘', icon: ClipboardCheck },
  ] },
  { title: '决策与模拟执行', items: [
    { id: 'decisions', label: '决策草稿', icon: FileSpreadsheet },
    { id: 'approvals', label: '审批中心', icon: ShieldCheck },
    { id: 'executions', label: '执行记录', icon: Truck },
    { id: 'compensations', label: '补偿记录', icon: RotateCcw },
  ] },
  { title: '数据与设置', items: [
    { id: 'connections', label: '平台接入', icon: Settings2 },
    { id: 'data', label: '数据与导入', icon: FileSpreadsheet },
    { id: 'catalog', label: '商品映射', icon: Boxes },
    { id: 'policy', label: '经营规则', icon: Settings2 },
  ] },
] satisfies Array<{ title: string; items: Array<{ id: RetailPage; label: string; icon: typeof Boxes }> }>;

export function RetailNavigation({ page, warnings, onNavigate }: { page: RetailPage; warnings: number; onNavigate: (page: RetailPage) => void }) {
  return <aside className="retail-navigation">
    <nav aria-label="经营导航">{groups.map(group => <div className="retail-nav-section" key={group.title}>
      <p className="retail-nav-group">{group.title}</p>
      {group.items.map(({ id, label, icon: Icon }) => <button key={id} aria-current={page === id || (id === 'executions' && page === 'batches') ? 'page' : undefined} onClick={() => onNavigate(id)}>
        <Icon size={16} aria-hidden="true"/>{label}{id === 'anomalies' && warnings > 0 && <span className="retail-tab-count">{warnings}</span>}
      </button>)}
    </div>)}</nav>
    <p className="retail-navigation-note">本地经营工作台<br/><span>审批与执行使用模拟账本</span></p>
  </aside>;
}
