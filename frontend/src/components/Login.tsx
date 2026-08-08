import React, { useState } from 'react'
import { api, setAuth, ApiError } from '../api/client'
import { useApp } from '../state/AppContext'
import { navigate } from '../App'

/**
 * 登录页（UIUX §4.1）：居中卡片 420px，无注册入口（B 端账号由运营开通 FR-101/102）
 * POST /api/v1/auth/login {account, password} → {token, user, tenant}
 * 分流：admin → #/admin；owner/employee → #/workspace（paused/expired 由工作台整页冻结页接管）
 */
export default function Login(): React.JSX.Element {
  const { setSession } = useApp()
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!account.trim() || !password) {
      setError('请输入账号和密码')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await api.login(account.trim(), password)
      setAuth(res.token, res.user, res.tenant)
      setSession(res.user, res.tenant)
      if (res.user.role === 'admin') navigate('/admin')
      else navigate('/workspace')
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError('网络异常，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-brand">
        <div className="logo-big">I</div>
        <h1>Informate</h1>
        <p>不用搭的行业 AI 工作台 · 对话即能力</p>
      </div>
      <form className="login-card" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="login-account">账号</label>
          <input
            id="login-account"
            className={`input ${error ? 'input-error' : ''}`}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="请输入账号"
            autoComplete="username"
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">密码</label>
          <input
            id="login-password"
            className={`input ${error ? 'input-error' : ''}`}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入密码"
            autoComplete="current-password"
          />
        </div>
        {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
        <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
          {loading ? '登录中…' : '登 录'}
        </button>
        <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-3)', marginTop: 12 }}>
          忘记密码？请联系企业管理员
        </div>
      </form>
      <div className="login-footer">
        <div>本平台 AI 生成内容均带「AI 生成」标识</div>
        <div>备案信息 · © 2026 Informate</div>
      </div>
    </div>
  )
}
