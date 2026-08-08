import React, { useEffect, useState } from 'react'
import { useApp } from '../../state/AppContext'
import Dashboard from './Dashboard'
import Tenants from './Tenants'
import ScenarioDeploy from './ScenarioDeploy'
import CreditAdmin from './CreditAdmin'
import PriceConfig from './PriceConfig'
import SessionAudit from './SessionAudit'
import Employees from './Employees'
import ExportPage from './ExportPage'

const NAV = [
  { key: 'dashboard', label: '运营看板' },
  { key: 'tenants', label: '租户管理' },
  { key: 'deploy', label: '场景部署' },
  { key: 'credit', label: '积分管理' },
  { key: 'price', label: '价格配置' },
  { key: 'audit', label: '会话审计' },
  { key: 'employees', label: '员工管理' },
  { key: 'export', label: '数据导出' },
]

/** 从 hash 解析子页： #/admin/tenants → 'tenants' */
function pageFromHash(): string {
  const parts = window.location.hash.replace(/^#/, '').split('/')
  return parts[2] || 'dashboard'
}

/**
 * T11 管理后台（UIUX §4.6，admin 角色专属）
 * 与工作台同设计体系但更紧凑；模块：租户/场景部署/积分/价格配置/会话审计/员工 + 数据导出 + 看板
 */
export default function AdminLayout(): React.JSX.Element {
  const { user, logout } = useApp()
  const [page, setPage] = useState<string>(pageFromHash())

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (key: string): void => {
    window.location.hash = `/admin/${key}`
  }

  return (
    <div className="admin-layout">
      <header className="topbar">
        <div className="topbar-brand">
          <span className="logo">I</span>
          <span>Informate 管理后台</span>
        </div>
        <div className="topbar-right">
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {user?.name}（运营管理员）
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => go('dashboard')}>工作台视角</button>
          <button className="btn btn-ghost btn-sm" onClick={logout}>退出</button>
        </div>
      </header>
      <div className="admin-body">
        <nav className="admin-nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`admin-nav-item ${page === n.key ? 'active' : ''}`}
              onClick={() => go(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="admin-content" key={page}>
          {page === 'dashboard' && <Dashboard />}
          {page === 'tenants' && <Tenants />}
          {page === 'deploy' && <ScenarioDeploy />}
          {page === 'credit' && <CreditAdmin />}
          {page === 'price' && <PriceConfig />}
          {page === 'audit' && <SessionAudit />}
          {page === 'employees' && <Employees />}
          {page === 'export' && <ExportPage />}
        </div>
      </div>
    </div>
  )
}
