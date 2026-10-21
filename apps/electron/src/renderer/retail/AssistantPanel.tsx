import { PageHeader } from './PageHeader';
import type { RetailPage } from './RetailNavigation';

export function AssistantPanel({ onNavigate, onOpenAgent }: { onNavigate: (page: RetailPage) => void; onOpenAgent: () => void }) {
  return <section data-testid="retail-assistant">
    <PageHeader title="经营助手">从具体异常进入调查，让分析对应到商品、店铺和经营日期。</PageHeader>
    <div className="retail-assistant-scenarios">
      {([
        ['anomalies', '商品卖得多，毛利却偏低', '核对成交价、优惠和成本，选中异常后开始调查。', '查看经营异常'],
        ['inventory', '销量下降，是否该补货', '先核对可售、覆盖天数和到货交期，再形成补货草稿。', '查看库存与补货'],
        ['ads', '广告回报下降，退款影响多大', '核对可比窗口、归因口径与退款后结算证据。', '查看广告经营'],
      ] as const).map(([id, title, description, action]) => <section className="retail-panel" key={id}>
        <h2>{title}</h2><p>{description}</p><div className="retail-inline-actions"><button onClick={() => onNavigate(id)}>{action}</button></div>
      </section>)}
    </div>
    <section className="retail-panel"><div className="retail-section-title"><div><h2>接着处理已有分析</h2><p>调查保留证据与复核记录；决策进入本地模拟审批，复盘记录后续观察。</p></div></div>
      <div className="retail-inline-actions"><button onClick={() => onNavigate('investigations')}>查看调查记录</button><button onClick={() => onNavigate('decisions')}>查看决策草稿</button><button onClick={() => onNavigate('reviews')}>查看经营复盘</button></div>
    </section>
    <section className="retail-panel"><div className="retail-section-title"><div><h2>通用会话与高级能力</h2><p>通用会话用于自选资料分析。API、MCP、本地文件夹、技能、项目与通用自动化在高级工作台管理。</p></div></div>
      <p>通用会话的状态和标签用于整理会话；“待审查”不等于业务审批。此入口不会自动附带当前商品证据，进行经营调查请从上方场景中的异常记录进入。</p>
      <div className="retail-inline-actions"><button onClick={onOpenAgent}>打开高级工作台</button></div>
    </section>
  </section>;
}
