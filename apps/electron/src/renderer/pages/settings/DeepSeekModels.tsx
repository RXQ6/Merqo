import { useState } from 'react'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { SettingsSection, SettingsCard } from '@/components/settings'

export function DeepSeekModels({ connection, onChange }: { connection: LlmConnectionWithStatus; onChange: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = async () => {
    setBusy(true); setError('')
    try {
      const result = await window.electronAPI.refreshLlmConnectionModels(connection.slug)
      if (!result.success) setError(result.error || '刷新失败，已保留原有模型')
      await onChange()
    } catch { setError('刷新失败，已保留原有模型') }
    finally { setBusy(false) }
  }
  const choose = async (id: string) => {
    setBusy(true); setError('')
    try {
      const { isAuthenticated: _a, authError: _b, isDefault: _c, ...data } = connection
      const result = await window.electronAPI.saveLlmConnection({ ...data, defaultModel: id })
      if (!result.success) setError(result.error || '保存模型失败')
      await onChange()
    } catch { setError('保存模型失败') }
    finally { setBusy(false) }
  }
  const status = connection.modelDiscovery
  const models = connection.models ?? []
  const missing = connection.defaultModel && !models.some(m => (typeof m === 'string' ? m : m.id) === connection.defaultModel)
  return <SettingsSection title={`DeepSeek 模型 · ${connection.name}`} description="展示该连接当前 API 可用的模型；历史模型和仅发布权重的模型不在此列表。">
    <SettingsCard>
      <div className="p-4 space-y-3" aria-label={`DeepSeek 动态模型 ${connection.slug}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground" role="status">
            {status?.source === 'live' ? '官方接口列表' : status?.source === 'cache' ? '缓存列表' : '本地预置列表（尚未成功同步）'} · {models.length} 个模型
            <div>最近成功同步：{status?.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : '尚无'}</div>
          </div>
          <Button variant="outline" disabled={busy} onClick={refresh}>{busy ? '处理中…' : '刷新模型'}</Button>
        </div>
        {(error || status?.error) && <p role="alert" className="text-sm text-amber-600">{error || status?.error}</p>}
        {missing && <p className="text-sm text-amber-600">当前选择 {connection.defaultModel?.replace(/^pi\//, '')} 未被最新列表返回，已保留；请选择可用模型。</p>}
        <div className="overflow-x-auto"><table className="w-full text-left text-xs" aria-label="DeepSeek 可用模型">
          <thead><tr><th className="py-2">模型 / 调用 ID</th><th>上下文 / 最大输出</th><th>图片输入</th><th>推理档位</th><th>选择</th></tr></thead>
          <tbody>{models.map(entry => {
            const m = typeof entry === 'string' ? undefined : entry
            const id = typeof entry === 'string' ? entry : entry.id
            return <tr key={id} className="border-t border-border/50">
              <td className="py-3 pr-3"><div>{m?.name || id.replace(/^pi\//, '')}</div><code className="text-muted-foreground">{id.replace(/^pi\//, '')}</code></td>
              <td>{m?.contextWindow ? m.contextWindow.toLocaleString() : '未知'} / {m?.maxOutputTokens?.toLocaleString() ?? '未知'}</td>
              <td>{m?.supportsImages === undefined ? '未知' : m.supportsImages ? '支持' : '不支持'}</td>
              <td>{m?.supportedReasoningEfforts?.join(' / ') || (m?.supportsThinking === false ? '不支持' : '未知')}</td>
              <td><Button variant="outline" size="sm" disabled={busy || connection.defaultModel === id} onClick={() => choose(id)}>{connection.defaultModel === id ? '当前模型' : '设为默认'}</Button></td>
            </tr>
          })}</tbody>
        </table></div>
      </div>
    </SettingsCard>
  </SettingsSection>
}
