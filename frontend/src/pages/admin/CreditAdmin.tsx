import React, { useEffect, useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { AdminOverview } from '../../api/types'
import { useApp } from '../../state/AppContext'
import { ExportButton, TXN_TYPE_LABEL, useExportRows } from './shared'

/**
 * T11 积分管理：看板摘要 + 手动调账（FR-703，POST /admin/adjust 留审计）+ 流水明细
 * 流水明细数据源：GET /api/v1/admin/export（CSV，含 tenant_id 过滤）——后端无 /admin/txns JSON 端点
 */
export default function CreditAdmin(): React.JSX.Element {
  const { toast } = useApp()
  const [overview, setOverview] = useState<AdminOverview['overview'] | null>(null)
  const [tenantId, setTenantId] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [adjusting, setAdjusting] = useState(false)
  const [filterTenant, setFilterTenant] = useState('')
  const { rows, loading, refresh } = useExportRows({ tenant_id: filterTenant || undefined })

  useEffect(() => {
    void api.adminOverview().then((r) => setOverview(r.overview)).catch(() => undefined)
  }, [])

  async function adjust(): Promise<void> {
    const num = Number(amount)
    if (!tenantId.trim() || !Number.isInteger(num) || num === 0) {
      toast('请填写租户 ID 与非零整数积分', 'warn')
      return
    }
    if (!note.trim()) {
      toast('手动调账必填备注（FR-703 留痕）', 'warn')
      return
    }
    setAdjusting(true)
    try {
      const res = await api.adminAdjust({ tenant_id: tenantId.trim(), amount: num, note })
      toast(res.message, 'success')
      setAmount('')
      setNote('')
      void api.adminOverview().then((r) => setOverview(r.overview)).catch(() => undefined)
      refresh()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '调账失败', 'error')
    } finally {
      setAdjusting(false)
    }
  }

  return (
    <div>
      <h2>积分管理</h2>
      <p className="admin-subtitle">调账走 POST /api/v1/admin/adjust；明细数据源 GET /api/v1/admin/export（CSV）</p>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
        <div className="stat-card"><div className="label">总余额</div><div className="value">{overview?.total_balance ?? '—'}</div></div>
        <div className="stat-card"><div className="label">累计收入</div><div className="value">{overview?.total_revenue ?? '—'}</div></div>
        <div className="stat-card"><div className="label">累计消耗</div><div className="value">{overview?.total_consumed ?? '—'}</div></div>
        <div className="stat-card"><div className="label">在途冻结</div><div className="value">{overview?.frozen_outstanding ?? '—'}</div></div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 20 }}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>手动调账（赠送 / 扣回，必填备注）</h3>
        <div className="filter-bar" style={{ marginBottom: 0 }}>
          <input className="input" placeholder="租户 ID（如 t-seed-001）" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
          <input className="input" placeholder="积分（正=赠送，负=扣回）" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 120 }} />
          <input className="input" placeholder="备注（必填，留审计）" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 200 }} />
          <button className="btn btn-primary btn-sm" disabled={adjusting} onClick={() => void adjust()}>
            {adjusting ? '提交中…' : '提交调账'}
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <strong style={{ fontSize: 13 }}>积分流水明细</strong>
        <input className="input" placeholder="按租户 ID 过滤" value={filterTenant} onChange={(e) => setFilterTenant(e.target.value)} style={{ width: 160 }} />
        <ExportButton label="导出当前流水" filters={{ tenant_id: filterTenant || undefined }} />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>租户</th>
              <th>类型</th>
              <th>积分</th>
              <th>余额</th>
              <th>轮次</th>
              <th>引用</th>
              <th>操作人</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9}><div className="loading-center"><span className="spinner" /> 加载中…</div></td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>暂无流水</td></tr>
            )}
            {!loading &&
              rows.slice(0, 100).map((r, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{r[12]?.slice(0, 16) ?? ''}</td>
                  <td>{r[2] ?? r[1] ?? ''}</td>
                  <td><span className={`badge ${r[3] === 'recharge' ? 'badge-active' : r[3] === 'unfreeze' ? 'badge-trial' : ''}`}>{TXN_TYPE_LABEL[r[3]] ?? r[3]}</span></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r[4]}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r[5]}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r[9] ?? ''}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{r[7]}/{r[8]?.slice(0, 12) ?? ''}</td>
                  <td style={{ fontSize: 12 }}>{r[10] ?? ''}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r[11] ?? ''}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
