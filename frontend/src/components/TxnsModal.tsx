import React, { useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { CreditTxn } from '../api/types'

interface Props {
  onClose: () => void
}

const TYPE_LABEL: Record<string, string> = {
  recharge: '充值',
  freeze: '冻结',
  settle: '扣费',
  unfreeze: '解冻',
  refund: '退款',
  adjust: '调账',
}

/** 金额带符号着色：正（充值/解冻/退款）=绿，负（冻结/扣费）=红 */
function amountCell(t: CreditTxn): React.JSX.Element {
  const sign = t.amount >= 0 ? '+' : ''
  const cls = t.amount >= 0 ? 'txn-pos' : 'txn-neg'
  return <span className={cls}>{sign}{t.amount}</span>
}

/**
 * 消费记录弹窗（FR-602/AC-602，仅主账号入口）
 * GET /api/v1/credit/txns 分页：时间 / 类型 / 积分变动 / 场景 / 说明
 */
export default function TxnsModal({ onClose }: Props): React.JSX.Element {
  const [rows, setRows] = useState<CreditTxn[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const pageSize = 20

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    api
      .txns(page, pageSize)
      .then((res) => {
        if (!alive) return
        setRows(res.data)
        setTotal(res.pagination.total)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? err.message : '流水加载失败')
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [page])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>消费记录</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
            全租户积分流水（充值 / 冻结 / 扣费 / 解冻 / 退款 / 调账，FR-602）
          </div>
          {loading && <div className="artifact-empty">加载中…</div>}
          {error && <div className="artifact-empty">{error}</div>}
          {!loading && !error && rows.length === 0 && (
            <div className="artifact-empty">暂无流水记录</div>
          )}
          {!loading && !error && rows.length > 0 && (
            <table className="txn-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>积分</th>
                  <th>场景</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                      {t.created_at?.replace('T', ' ').slice(0, 16)}
                    </td>
                    <td>{TYPE_LABEL[t.type] ?? t.type}</td>
                    <td>{amountCell(t)}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{t.scenario_id ?? '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-2)', maxWidth: 220 }}>
                      <span title={t.note ?? ''}>{t.note ?? (t.ref_type ? `${t.ref_type}:${t.ref_id}` : '')}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
            <div className="pager">
              <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                上一页
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{page} / {totalPages}（共 {total} 条）</span>
              <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                下一页
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
