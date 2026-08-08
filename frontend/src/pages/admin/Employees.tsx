import React, { useMemo, useState } from 'react'
import { TXN_TYPE_LABEL, useExportRows } from './shared'

/**
 * T11 员工管理（运营侧视图）
 * 接口对齐说明：员工 CRUD 走租户侧端点（GET/POST /api/v1/users、PATCH /api/v1/users/:id，owner 角色），
 * admin 侧暂无员工列表端点（后端 /admin/users 待 batchE 提供）。
 * 本页如实渲染：① 积分流水中的操作人活动（数据源 /admin/export）② 租户侧员工管理接口参考。
 */
export default function Employees(): React.JSX.Element {
  const { rows, loading, refresh } = useExportRows()

  const operatorStats = useMemo(() => {
    const map = new Map<string, { count: number; total: number; tenants: Set<string> }>()
    for (const r of rows) {
      const op = (r[10] ?? '').trim()
      if (!op) continue
      const cur = map.get(op) ?? { count: 0, total: 0, tenants: new Set<string>() }
      cur.count += 1
      cur.total += Number(r[4] ?? 0)
      if (r[1]) cur.tenants.add(r[1])
      map.set(op, cur)
    }
    return [...map.entries()]
      .map(([operator, v]) => ({ operator, count: v.count, total: v.total, tenants: [...v.tenants].join(', ') }))
      .sort((a, b) => b.count - a.count)
  }, [rows])

  return (
    <div>
      <h2>员工管理</h2>
      <p className="admin-subtitle">运营侧操作人活动视图 + 租户侧员工管理接口参考</p>
      <div className="api-note">
        接口对齐说明：员工 CRUD 为租户侧 owner 专属端点{' '}
        <code>GET/POST /api/v1/users</code>、<code>PATCH /api/v1/users/:id</code>（FR-105/706）；管理后台{' '}
        <code>/admin/users</code> 待后端 batchE 提供。下方表格为积分流水中的操作人（operator）活动汇总。
      </div>
      <div className="filter-bar">
        <strong style={{ fontSize: 13 }}>操作人活动（数据源 /admin/export）</strong>
        <button className="btn btn-outline btn-sm" onClick={refresh}>刷新</button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>操作人（user_id）</th>
              <th>操作次数</th>
              <th>涉及积分</th>
              <th>涉及租户</th>
              <th>最近操作类型</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5}><div className="loading-center"><span className="spinner" /> 加载中…</div></td></tr>
            )}
            {!loading && operatorStats.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>暂无操作记录</td></tr>
            )}
            {!loading &&
              operatorStats.slice(0, 100).map((s, i) => {
                const lastType = rows.find((r) => (r[10] ?? '').trim() === s.operator)?.[3] ?? ''
                return (
                  <tr key={i}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.operator}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{s.count}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{s.total}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-3)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.tenants}</td>
                    <td>{TXN_TYPE_LABEL[lastType] ?? lastType ?? '—'}</td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ padding: 16, marginTop: 20 }}>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>员工管理接口参考（租户侧，owner）</h3>
        <ul style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 2, listStyle: 'none' }}>
          <li><code>GET /api/v1/users</code> — 员工列表（含 credit_limit / credit_period / guide_seen）</li>
          <li><code>POST /api/v1/users</code> — 创建员工子账号 {'{name, password, credit_limit?, credit_period?}'}</li>
          <li><code>PATCH /api/v1/users/:id</code> — 停用/启用 + 调整限额（FR-105/706）</li>
        </ul>
      </div>
    </div>
  )
}
