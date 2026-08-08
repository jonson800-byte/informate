import React, { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AdminTenant } from '../../api/types'
import { SCENARIO_PACKAGE_CATALOG } from '../../api/types'

/**
 * T11 场景部署（运营侧视图）
 * 说明：后端 admin 侧暂无「部署列表」端点（部署开通走租户侧 POST /api/v1/scenarios/deploy，owner 角色）。
 * 本页展示：① 场景包目录（seed 预置）② 已开通场景的租户列表（GET /api/v1/admin/tenants 行业视角）。
 * 不做凭空造端点——接口缺口已如实标注，待后端 batchE 提供 /admin/scenario-deployments 后替换。
 */
export default function ScenarioDeploy(): React.JSX.Element {
  const [tenants, setTenants] = useState<AdminTenant[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void api
      .adminTenants({ pageSize: 100 })
      .then((r) => setTenants(r.data))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <h2>场景部署</h2>
      <p className="admin-subtitle">场景包目录 + 已部署租户概览（部署开通由租户主账号在租户侧完成）</p>
      <div className="api-note">
        接口对齐说明：<code>GET /api/v1/admin/scenario-deployments</code> 后端尚未提供；当前数据源为{' '}
        <code>GET /api/v1/admin/tenants</code> 与场景包目录常量。开通走 <code>POST /api/v1/scenarios/deploy</code>（owner）。
      </div>

      <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>场景包目录（seed 预置）</h3>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>场景包</th>
              <th>名称</th>
              <th>计费单元</th>
              <th>单价（积分）</th>
              <th>展示名模板</th>
            </tr>
          </thead>
          <tbody>
            {SCENARIO_PACKAGE_CATALOG.map((p) => (
              <tr key={p.id}>
                <td><span className="scenario-icon" style={{ display: 'inline-flex' }}>{p.emoji}</span></td>
                <td>{p.name}</td>
                <td>{p.unit === 'session' ? '会话（含 20 轮）' : '按张（image）'}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.deduct_points}</td>
                <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{p.display_name_template}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 14, margin: '20px 0 8px' }}>租户（按行业部署视角）</h3>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>企业名称</th>
              <th>行业</th>
              <th>二级行业</th>
              <th>状态</th>
              <th>部署场景</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5}><div className="loading-center"><span className="spinner" /> 加载中…</div></td></tr>
            )}
            {!loading &&
              tenants.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.industry}</td>
                  <td>{t.sub_industry ?? '—'}</td>
                  <td>{t.status}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {t.status === 'trial' || t.status === 'active'
                      ? `${t.industry}行业工作助手 · ${t.industry}营销生图`
                      : '冻结中（部署保留）'}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
