import React, { useState } from 'react'
import { api, ApiError } from '../../api/client'

interface Props {
  onClose: () => void
  onSuccess: () => void
}

/**
 * 新建租户弹窗（admin 从租户管理页开户）
 * 调 POST /api/v1/auth/register（T4：租户+主账号，trial 20 次会话，FR-101）
 */
export default function NewTenantModal({ onClose, onSuccess }: Props): React.JSX.Element {
  const [form, setForm] = useState({
    name: '',
    industry: '',
    sub_industry: '',
    owner_account: '',
    owner_password: '',
    owner_name: '',
    contact_phone: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(): Promise<void> {
    setError('')
    if (!form.name.trim() || !form.industry.trim() || !form.owner_account.trim() || form.owner_password.length < 6) {
      setError('请填写企业名称、行业、主账号，密码不少于 6 位')
      return
    }
    setLoading(true)
    try {
      await api.register({
        name: form.name.trim(),
        industry: form.industry.trim(),
        sub_industry: form.sub_industry.trim() || undefined,
        owner_account: form.owner_account.trim(),
        owner_password: form.owner_password,
        owner_name: form.owner_name.trim() || undefined,
        contact_phone: form.contact_phone.trim() || undefined,
      })
      onSuccess()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '开户失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>新建租户（开户）</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
            创建后租户为试用状态（20 次会话），主账号可登录工作台（FR-101）
          </div>
          <div className="form-grid">
            <label className="form-field">
              企业名称 *
              <input className="input" value={form.name} onChange={set('name')} placeholder="如：XX医疗美容机构" />
            </label>
            <label className="form-field">
              行业 *（一级）
              <input className="input" value={form.industry} onChange={set('industry')} placeholder="如：医美" />
            </label>
            <label className="form-field">
              二级行业
              <input className="input" value={form.sub_industry} onChange={set('sub_industry')} placeholder="如：植发" />
            </label>
            <label className="form-field">
              主账号登录名 *
              <input className="input" value={form.owner_account} onChange={set('owner_account')} placeholder="登录用账号" />
            </label>
            <label className="form-field">
              主账号密码 *（≥6 位）
              <input className="input" type="password" value={form.owner_password} onChange={set('owner_password')} />
            </label>
            <label className="form-field">
              负责人姓名
              <input className="input" value={form.owner_name} onChange={set('owner_name')} />
            </label>
            <label className="form-field">
              联系电话
              <input className="input" value={form.contact_phone} onChange={set('contact_phone')} />
            </label>
          </div>
          {error && <div className="system-bar danger" style={{ marginTop: 8 }}>{error}</div>}
          <div className="modal-actions" style={{ marginTop: 14 }}>
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className="btn btn-primary" disabled={loading} onClick={() => void submit()}>
              {loading ? '创建中…' : '创建租户'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
