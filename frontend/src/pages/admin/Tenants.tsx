import React, { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AdminTenant } from '../../api/types'
import { ExportButton } from './shared'

const STATUS_LABEL: Record<string, string> = {
  trial: '试用',
  active: '正式',
  paused: '冻结',
  expired: '到期',
}

/** T11 租户管理：GET /api/v1/admin/tenants（分页/行业/状态筛选） */
export default function Tenants(): React.JSX.Element {
  const [data, setData] = useState<AdminTenant[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [status, setStatus] = useState('')
  const [industry, setIndustry] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    void api
      .adminTenants({ status: status || undefined, industry: industry || undefined, page, pageSize })
      .then((r) => {
        setData(r.data)
        setTotal(r.pagination.total)
      })
      .finally(() => setLoading(false))
  }, [page, pageSize, status, industry])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div>
      <h2>租户管理</h2>
      <p className="admin-subtitle">数据来自 GET /api/v1/admin/tenants（FR-70 段，admin 专属）</p>
      <div className="filter-bar">
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
          <option value="">全部状态</option>
          <option value="trial">试用</option>
          <option value="active">正式</option>
          <option value="paused">冻结</option>
          <option value="expired">到期</option>
        </select>
        <input
          className="input"
          placeholder="行业筛选（如：医美）"
          value={industry}
          onChange={(e) => { setIndustry(e.target.value); setPage(1) }}
        />
        <ExportButton label="导出租户积分流水" />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>企业名称</th>
              <th>行业</th>
              <th>二级行业</th>
              <th>状态</th>
              <th>余额</th>
              <th>试用（已用/限额）</th>
              <th>套餐</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8}><div className="loading-center"><span className="spinner" /> 加载中…</div></td></tr>
            )}
            {!loading && data.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>暂无租户</td></tr>
            )}
            {!loading &&
              data.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.industry}</td>
                  <td>{t.sub_industry ?? '—'}</td>
                  <td><span className={`badge ${STATUS_LABEL[t.status] === '冻结' ? 'badge-paused' : t.status === 'active' ? 'badge-active' : 'badge-trial'}`}>{STATUS_LABEL[t.status] ?? t.status}</span></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{t.balance}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{t.trial_sessions_used} / {t.trial_session_limit}</td>
                  <td>{t.plan ?? '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{t.created_at?.replace('T', ' ').slice(0, 16) ?? '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="pagination-bar">
        <button className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
        <span>第 {page} / {totalPages} 页 · 共 {total} 条</span>
        <button className="btn btn-outline btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</button>
      </div>
    </div>
  )
}
