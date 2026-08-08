import React, { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AdminOverview } from '../../api/types'

/** T11 运营看板（FR-708 简版）：GET /api/v1/admin/overview 统计卡 */
export default function Dashboard(): React.JSX.Element {
  const [data, setData] = useState<AdminOverview['overview'] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void api
      .adminOverview()
      .then((r) => setData(r.overview))
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
  }, [])

  if (error) {
    return (
      <div>
        <h2>运营看板</h2>
        <div className="api-note">加载失败：{error}</div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="loading-center">
        <span className="spinner" /> 加载看板…
      </div>
    )
  }

  const stats: { label: string; value: string | number; sub?: string }[] = [
    { label: '租户总数', value: data.tenant_count, sub: `活跃 ${data.tenant_active} · 冻结 ${data.tenant_paused}` },
    { label: '总余额（积分）', value: data.total_balance },
    { label: '累计收入', value: data.total_revenue, sub: `今日 +${data.today_revenue}` },
    { label: '累计消耗', value: data.total_consumed, sub: `今日 ${data.today_consumed}` },
    { label: '在途冻结', value: data.frozen_outstanding, sub: `最低冻结额 ${data.min_freeze}` },
    { label: '手动调账净额', value: data.adjust_net },
  ]

  return (
    <div>
      <h2>运营看板</h2>
      <p className="admin-subtitle">数据来自 GET /api/v1/admin/overview（积分看板简版，FR-708）</p>
      <div className="stat-grid">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <div className="label">{s.label}</div>
            <div className="value">{s.value}</div>
            {s.sub && <div className="sub">{s.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
