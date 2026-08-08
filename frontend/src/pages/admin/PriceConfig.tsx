import React, { useEffect, useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { PriceConfigItem } from '../../api/types'
import { useApp } from '../../state/AppContext'

const KEY_LABEL: Record<string, string> = {
  'credit.work_assistant.session': '会话基础价（含 20 轮）',
  'credit.image_task': '生图单价',
  'credit.round_extra': '超轮单价（第 21 轮起）',
  'credit.round_limit': '单会话轮次上限',
  'credit.min_freeze': '最低冻结额（欠费阈值）',
  'recharge.100': '充值 100 元到账',
  'recharge.500': '充值 500 元到账',
  'recharge.2000': '充值 2000 元到账',
}

/**
 * T11 价格配置（FR-704，AC-704）：GET/PUT /api/v1/admin/price-config
 * 变量表 + 修改即生效 + 留审计（后端写入新版本不覆盖历史）
 */
export default function PriceConfig(): React.JSX.Element {
  const { toast } = useApp()
  const [items, setItems] = useState<PriceConfigItem[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ key: string; value: string; note: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const load = (): void => {
    setLoading(true)
    void api
      .adminPriceConfig()
      .then((r) => setItems(r.data))
      .catch((e) => toast(e instanceof ApiError ? e.message : '加载失败', 'error'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function save(): Promise<void> {
    if (!editing) return
    setSaving(true)
    try {
      const res = await api.adminUpdatePrice(editing.key, editing.value, editing.note || undefined)
      toast(res.message, 'success')
      setEditing(null)
      load()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <h2>价格配置</h2>
      <p className="admin-subtitle">GET / PUT /api/v1/admin/price-config — 修改即生效，新会话/新任务按新价计费（FR-704）</p>
      <div className="api-note">
        变更写入 <code>price_config</code> 新版本（<code>effective_at</code> 当前时间即刻生效），不覆盖历史；所有修改留审计。
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>配置项</th>
              <th>key</th>
              <th>当前值（积分）</th>
              <th>来源</th>
              <th>生效时间</th>
              <th>操作人</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7}><div className="loading-center"><span className="spinner" /> 加载中…</div></td></tr>
            )}
            {!loading &&
              items.map((it) => (
                <tr key={it.key}>
                  <td>{KEY_LABEL[it.key] ?? it.key}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)' }}><code>{it.key}</code></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{it.value}</td>
                  <td>{it.source === 'price_config' ? '已配置' : '默认值'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{it.effective_at ? it.effective_at.slice(0, 16) : '—'}</td>
                  <td style={{ fontSize: 12 }}>{it.operator ?? '—'}</td>
                  <td>
                    <button className="btn btn-outline btn-sm" onClick={() => setEditing({ key: it.key, value: it.value, note: '' })}>
                      修改
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>修改单价：{KEY_LABEL[editing.key] ?? editing.key}</h3>
              <button className="modal-close" onClick={() => setEditing(null)}>×</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>新值（正整数积分）</label>
                <input
                  className="input"
                  value={editing.value}
                  onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                  placeholder="例如 10"
                />
              </div>
              <div className="field">
                <label>变更备注（留审计）</label>
                <input
                  className="input"
                  value={editing.note}
                  onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                  placeholder="例如：双十一活动价"
                />
              </div>
              <button className="btn btn-primary btn-block" disabled={saving} onClick={() => void save()}>
                {saving ? '保存中…' : '保存并生效'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
