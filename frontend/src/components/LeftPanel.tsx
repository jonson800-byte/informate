import React from 'react'
import type { ScenarioDeployment } from '../api/types'

interface Props {
  scenarios: ScenarioDeployment[]
  activeDepId: string
  onSelect: (depId: string) => void
  tenantStatus: string
  balance: number
  trialRemaining: number
  isOwner: boolean
  isTrial: boolean
  sessionPrice: number
  imagePrice: number
  imageDisplayPrice: number
  onRecharge: () => void
  onTxns: () => void
}

/**
 * 左栏 240px（UIUX §2.2）：场景列表（数据驱动 GET /api/v1/scenarios，仅 active）
 * + 底部余额卡（主账号含充值/消费记录入口；余额 < 30 琥珀预警 FR-605）
 */
export default function LeftPanel({
  scenarios,
  activeDepId,
  onSelect,
  balance,
  trialRemaining,
  isOwner,
  isTrial,
  sessionPrice,
  imagePrice,
  imageDisplayPrice,
  onRecharge,
  onTxns,
}: Props): React.JSX.Element {
  const lowBalance = balance < 30 && !isTrial

  return (
    <aside className="pane-left">
      <div className="scenario-list">
        <div style={{ padding: '4px 12px 8px', fontSize: 12, color: 'var(--text-3)' }}>场景</div>
        {scenarios.length === 0 && (
          <div className="artifact-empty">
            {isOwner ? '暂无可用场景，请联系管理员部署' : '暂无可用场景，请联系管理员开通'}
          </div>
        )}
        {scenarios.map((s) => {
          const unit = s.meta?.pricing.unit
          const price = unit === 'image' ? imageDisplayPrice : sessionPrice
          return (
            <div
              key={s.id}
              className={`scenario-item ${s.id === activeDepId ? 'active' : ''}`}
              onClick={() => onSelect(s.id)}
            >
              <span className="scenario-icon">{s.meta?.emoji ?? '🧩'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="scenario-name">
                  {s.display_name}
                  {unit === 'image' && <span className="async-tag">异步</span>}
                </div>
                <div className="scenario-meta">
                  {unit === 'image' ? `生图 ${price} 积分/张` : `会话 ${price} 积分（含 20 轮）`}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 余额卡（底部固定） */}
      <div className={`balance-card ${lowBalance ? 'warn' : ''}`}>
        <div className="balance-label">积分余额</div>
        <div className="balance-num">{balance}</div>
        {lowBalance && (
          <div className="trial-remaining" role="alert">余额即将不足（&lt;30），建议充值</div>
        )}
        {isTrial && <div className="trial-remaining">试用剩余 {trialRemaining} 次会话</div>}
        <div className="balance-actions">
          {isOwner && (
            <button className="btn btn-primary btn-sm" onClick={onRecharge}>
              充值
            </button>
          )}
          {isOwner && <button className="btn btn-outline btn-sm" onClick={onTxns}>消费记录</button>}
        </div>
      </div>
    </aside>
  )
}
