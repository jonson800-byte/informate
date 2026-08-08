import React, { useState } from 'react'
import { useApp } from '../../state/AppContext'
import { ExportButton, TXN_TYPE_LABEL, useExportRows } from './shared'

/** T11 数据导出（FR-707）：按租户/类型导出积分流水 CSV（GET /api/v1/admin/export） */
export default function ExportPage(): React.JSX.Element {
  const { toast } = useApp()
  const [tenantId, setTenantId] = useState('')
  const [type, setType] = useState('')
  const { rows, loading, refresh } = useExportRows({ tenant_id: tenantId || undefined, type: type || undefined })

  return (
    <div>
      <h2>数据导出</h2>
      <p className="admin-subtitle">积分流水导出 CSV（GET /api/v1/admin/export，BOM 防中文乱码）</p>
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="filter-bar" style={{ marginBottom: 0 }}>
          <input className="input" placeholder="租户 ID（可选，全部租户留空）" value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={{ width: 220 }} />
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">全部流水类型</option>
            <option value="recharge">充值</option>
            <option value="freeze">冻结</option>
            <option value="settle">结算</option>
            <option value="unfreeze">解冻退回</option>
            <option value="adjust">调账</option>
          </select>
          <ExportButton label="导出 CSV" filters={{ tenant_id: tenantId || undefined, type: type || undefined }} />
        </div>
      </div>
      <div className="filter-bar">
        <strong style={{ fontSize: 13 }}>导出内容预览（前 100 条）</strong>
        <button className="btn btn-outline btn-sm" onClick={refresh}>刷新</button>
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
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7}><div className="loading-center"><span className="spinner" /> 加载中…</div></td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>暂无数据</td></tr>
            )}
            {!loading &&
              rows.slice(0, 100).map((r, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{r[12]?.slice(0, 16) ?? ''}</td>
                  <td>{r[2] ?? r[1] ?? ''}</td>
                  <td>{TXN_TYPE_LABEL[r[3]] ?? r[3]}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r[4]}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r[5]}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r[9] ?? ''}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r[11] ?? ''}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!loading && (
        <div className="pagination-bar">
          <span>共 {rows.length} 条记录（{rows.length > 100 ? '预览截断' : '全部展示'}）· 导出按钮获取完整 CSV</span>
          <button className="btn btn-ghost btn-sm" onClick={() => toast('完整数据请使用右上「导出 CSV」按钮', 'info')}>?</button>
        </div>
      )}
    </div>
  )
}
