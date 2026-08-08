import React, { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { TenantInfo, UserInfo } from '../api/types'
import { clearAuth, getCachedTenant, getCachedUser, getToken } from '../api/client'

/* ---------- Toast 轻提示（UIUX §2.5：右上滑入，3s 自动消失，可堆叠） ---------- */
export interface ToastItem {
  id: number
  message: string
  type: 'info' | 'success' | 'error' | 'warn'
}

interface AppContextValue {
  user: UserInfo | null
  tenant: TenantInfo | null
  token: string | null
  /** 登录成功后的会话上下文（从后端 login 响应写入） */
  setSession: (user: UserInfo, tenant: TenantInfo | null) => void
  logout: () => void
  /** 刷新租户信息（auth/me），返回最新 tenant（可能为 null） */
  refreshTenant: () => Promise<TenantInfo | null>
  toasts: ToastItem[]
  toast: (message: string, type?: ToastItem['type']) => void
  dismissToast: (id: number) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用')
  return ctx
}

let toastSeq = 1

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<UserInfo | null>(() => getCachedUser())
  const [tenant, setTenant] = useState<TenantInfo | null>(() => getCachedTenant())
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const tokenRef = useRef<string | null>(getToken())
  const timersRef = useRef<Map<number, number>>(new Map())

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const toast = useCallback(
    (message: string, type: ToastItem['type'] = 'info') => {
      const id = toastSeq++
      setToasts((prev) => [...prev.slice(-4), { id, message, type }])
      const timer = window.setTimeout(() => dismissToast(id), 3000)
      timersRef.current.set(id, timer)
    },
    [dismissToast],
  )

  const setSession = useCallback((u: UserInfo, t: TenantInfo | null) => {
    setUser(u)
    setTenant(t)
  }, [])

  const logout = useCallback(() => {
    clearAuth()
    tokenRef.current = null
    setUser(null)
    setTenant(null)
    window.location.hash = '/login'
  }, [])

  const refreshTenant = useCallback(async () => {
    const { api } = await import('../api/client')
    try {
      const me = await api.me()
      setUser(me.user)
      setTenant(me.tenant)
      return me.tenant
    } catch {
      return null
    }
  }, [])

  return (
    <AppContext.Provider
      value={{ user, tenant, token: tokenRef.current, setSession, logout, refreshTenant, toasts, toast, dismissToast }}
    >
      {children}
    </AppContext.Provider>
  )
}

export function ToastStack(): React.JSX.Element {
  const { toasts, dismissToast } = useApp()
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`} onClick={() => dismissToast(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
