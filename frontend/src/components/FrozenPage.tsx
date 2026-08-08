import React from 'react'
import type { TenantStatus } from '../api/types'

interface Props {
  status: TenantStatus
  isOwner: boolean
  onRecharge: () => void
  onLogout: () => void
}

/**
 * T10 冻结提示页（UIUX §4.5 / FR-106，AC-106）
 * 整页替换工作台，无功能入口；原因区分欠费（paused）/ 到期（expired）；
 * 主账号可立即充值（充值即恢复 active，AC-605）；员工提示联系管理员
 */
export default function FrozenPage({ status, isOwner, onRecharge, onLogout }: Props): React.JSX.Element {
  const expired = status === 'expired'
  return (
    <div className="full-page-state">
      <div className="state-card">
        <div className="state-icon">⏸️</div>
        <h2>{expired ? '服务已到期' : '服务已暂停'}</h2>
        <p>原因：{expired ? '服务到期（expired）' : '余额不足（欠费冻结）'}</p>
        <p>历史数据已保留，{expired ? '续费' : '充值'}后即可恢复使用</p>
        <p style={{ color: 'var(--text-3)' }}>如有疑问请联系运营：400-000-0000</p>
        <div className="actions">
          {isOwner ? (
            <>
              <button className="btn btn-primary" onClick={onRecharge}>
                立即充值
              </button>
              {expired && (
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  到期后如需停用，可先导出数据再联系运营（FR-505）
                </span>
              )}
            </>
          ) : (
            <p style={{ color: 'var(--warn)' }}>请联系企业管理员充值</p>
          )}
          <button className="btn btn-ghost" onClick={onLogout}>
            退出登录
          </button>
        </div>
      </div>
    </div>
  )
}
