import React, { useState } from 'react'
import { api, ApiError } from '../api/client'
import { DEFAULT_PRICES } from '../api/types'
import { useApp } from '../state/AppContext'

interface Props {
  onClose: () => void
  onSuccess: () => void
  /** 后台价格配置（workspace.prices，FR-704 可配；后端返回字符串值） */
  prices?: Record<string, string | number>
}

const TIER_YUAN = [100, 500, 2000] as const
const TIER_GIFT: Record<number, string> = { 100: '赠 10%', 500: '赠 20%', 2000: '赠 25%' }
const TIER_TAG: Record<number, string | undefined> = { 500: '最受欢迎', 2000: '最高性价比' }

/**
 * T10 充值弹窗（UIUX §4.3 / FR-601，AC-601）
 * 三档位：100=1100 / 500=6000 / 2000=25000（后台 price_config 可配，FR-704）
 * POST /api/v1/credit/recharge {tier} → 即时到账；trial/paused 充值即转 active（AC-504/605）
 */
export default function RechargeModal({ onClose, onSuccess, prices }: Props): React.JSX.Element {
  const pointOf = (yuan: number) => Number(prices?.[`recharge.${yuan}`]) || DEFAULT_PRICES.recharge[yuan as keyof typeof DEFAULT_PRICES.recharge]
  const TIERS = TIER_YUAN.map((yuan) => ({ yuan, points: pointOf(yuan), gift: TIER_GIFT[yuan], tag: TIER_TAG[yuan] }))
  const { user, toast } = useApp()
  const [selected, setSelected] = useState(500)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (user?.role !== 'owner') {
    // 员工无充值入口（FR-105）——防御性兜底
    return (
      <div className="modal-mask" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-body" style={{ textAlign: 'center', padding: 32 }}>
            <p style={{ color: 'var(--text-2)' }}>充值需主账号操作，请联系企业管理员</p>
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={onClose}>
              知道了
            </button>
          </div>
        </div>
      </div>
    )
  }

  async function pay(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const res = await api.recharge(selected, `recharge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      toast(res.message, 'success')
      onSuccess()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '充值失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>充值积分</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            1 元 = 10 积分 · 积分长期有效 · 全公司员工共享（FR-606）
          </div>
          <div className="recharge-tiers">
            {TIERS.map((t) => (
              <div
                key={t.yuan}
                className={`tier-card ${selected === t.yuan ? 'selected' : ''}`}
                onClick={() => setSelected(t.yuan)}
              >
                {t.tag && <span className="tier-tag">{t.tag}</span>}
                <div className="price">¥{t.yuan}</div>
                <div className="points">{t.points} 积分</div>
                <div className="gift">{t.gift}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
            支付方式：对公转账 / 在线支付（渠道待定，MVP 演示直接到账）
          </div>
          {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
          <button className="btn btn-primary btn-block" disabled={loading} onClick={() => void pay()}>
            {loading ? '支付中…' : `立即支付 ¥${selected}`}
          </button>
          <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center', marginTop: 10 }}>
            充值即开通正式版：移除试用水印、解锁跨场景传递（FR-504）
          </div>
        </div>
      </div>
    </div>
  )
}
