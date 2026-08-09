import React, { useEffect, useState } from 'react'
import { AppProvider, ToastStack, useApp } from './state/AppContext'
import Login from './components/Login'
import Workspace from './components/Workspace'
import AdminLayout from './pages/admin/AdminLayout'
import ErrorBoundary from './ErrorBoundary'
import { api } from './api/client'

/* ---------- 极简 hash 路由（零额外依赖） ----------
 * #/login      登录页
 * #/workspace  三栏工作台（租户侧 owner/employee）
 * #/admin      管理后台（admin 运营侧）
 */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash.replace(/^#/, '') || '/login')
  useEffect(() => {
    const onHash = () => setHash(window.location.hash.replace(/^#/, '') || '/login')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return hash
}

export function navigate(path: string): void {
  window.location.hash = path
}

function Router(): React.JSX.Element {
  const route = useHashRoute()
  const { user, setSession, logout } = useApp()
  const [verifying, setVerifying] = useState(!!user)

  // 已有缓存 token：启动时用 /auth/me 校验并刷新租户状态（trial→active 等）
  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      try {
        const me = await api.me()
        if (!cancelled) setSession(me.user, me.tenant)
      } catch {
        if (!cancelled) logout()
      } finally {
        if (!cancelled) setVerifying(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (verifying) {
    return (
      <div className="loading-center" style={{ height: '100%' }}>
        <span className="spinner" /> 正在进入工作台…
      </div>
    )
  }

  if (!user) {
    return (
      <>
        {route !== '/login' && <RedirectToLogin />}
        <Login />
      </>
    )
  }

  // 登录后按角色分流；未登录访问受保护页 → 登录页
  // 注意：管理后台子路由为 #/admin/{key}，需用 startsWith（否则点击导航被 RedirectToAdmin 弹回）
  if (route.startsWith('/admin')) {
    if (user.role !== 'admin') return <RedirectToLogin />
    return <AdminLayout />
  }
  if (route === '/workspace') {
    if (user.role === 'admin') return <RedirectToAdmin />
    return <Workspace />
  }
  return user.role === 'admin' ? <RedirectToAdmin /> : <RedirectToWorkspace />
}

function RedirectToLogin(): null {
  useEffect(() => {
    navigate('/login')
  }, [])
  return null
}
function RedirectToWorkspace(): null {
  useEffect(() => {
    navigate('/workspace')
  }, [])
  return null
}
function RedirectToAdmin(): null {
  useEffect(() => {
    navigate('/admin')
  }, [])
  return null
}

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <AppProvider>
        <Router />
        <ToastStack />
      </AppProvider>
    </ErrorBoundary>
  )
}
