import React, { useMemo, useState } from 'react'
import { ExportButton, TXN_TYPE_LABEL, useExportRows } from './shared'

/**
 * T11 会话审计：会话/轮次视角的计费流水明细
 * 数据源：GET /api/v1/admin/export（CSV，含 round_no/ref_type=conversation 的逐轮结算记录）。
 * 说明：后端暂无独立会话审计端点，本页如实使用积分流水导出接口渲染（含轮次列），
 * 待后端提供 /admin/conversations 后替换。
 */
export default function SessionAudit(): React.JSX.Element {
  const [filterType, setFilterType] = useState('')
  const [filterTenant, setFilterTenant] = useState('')
  const { rows, loading, refresh } = useExportRows({ type: filterType || undefined, tenant_id: filterTenant || undefined })

  const convRows = useMemo(() => rows.filter((r) => (r[7] ?? '') === 'conversation' || (r[9] ?? '') !== ''), [rows])

  return (
    <div>
      <h2>会话审计</h2>
      <p className="admin-subtitle">逐轮计费流水（round_no 列 = 会话轮次；数据源 GET /api/v1/admin/export）</p>
      <div className="api-note">
        接口对齐说明：后端 <code>GET /api/v1/admin/conversations</code> 尚未提供；当前以积分流水导出（
        <code>ref_type=conversation</code> 的行）渲染会话审计视图。
      </div>
      <div className="filter-bar">
        <select className="input" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <option value="">全部类型</option>
          <option value="recharge">充值</option>
          <option value="freeze">冻结</option>
          <option value="settle">结算</option>
          <option value="unfreeze">解冻退回</option>
          <option value="adjust">调账</option>
        </select>
        <input className="input" placeholder="按租户 ID 过滤" value={filterTenant} onChange={(e) => setFilterTenant(e.target.value)} style={{ width: 160 }} />
        <button className="btn btn-outline btn-sm" onClick={refresh}>刷新</button>
        <ExportButton label="导出审计明细" filters={{ type: filterType || undefined, tenant_id: filterTenant || undefined }} />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>租户</th>
              <th>类型</th>
              <th>积分</th>
              <th>轮次</th>
              <th>会话/任务引用</th>
              <th>场景</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8}><div className="loading-center"><span className="spinner" /> 加载中…</div></td></tr>
            )}
            {!loading && convRows.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>暂无会话计费流水</td></tr>
            )}
            {!loading &&
              convRows.slice(0, 200).map((r, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{r[12]?.slice(0, 16) ?? ''}</td>
                  <td>{r[2] ?? r[1] ?? ''}</td>
                  <td><span className={`badge ${r[3] === 'recharge' ? 'badge-active' : r[3] === 'settle' ? 'badge-active' : r[3] === 'unfreeze' ? 'badge-trial' : ''}`}>{TXN_TYPE_LABEL[r[3]] ?? r[3]}</span></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r[4]}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r[9] || '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r[8] ?? ''}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{r[6] ?? ''}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r[11] ?? ''}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
