import React, { useCallback, useEffect, useState } from 'react'
import { api, parseCsv } from '../../api/client'
import { useApp } from '../../state/AppContext'

/** 导出 CSV 行（header 索引映射到中文列名） */
export const EXPORT_HEADERS = [
  '流水ID',
  '租户ID',
  '租户名称',
  '类型',
  '积分',
  '余额',
  '场景ID',
  '引用类型',
  '引用ID',
  '轮次',
  '操作人',
  '备注',
  '时间',
] as const

/** 读取 /admin/export（CSV）并解析为表格行；带租户/类型过滤 */
export function useExportRows(filters: { tenant_id?: string; type?: string } = {}): {
  rows: string[][]
  header: string[]
  loading: boolean
  error: string
  refresh: () => void
} {
  const { toast } = useApp()
  const [rows, setRows] = useState<string[][]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const csv = await api.adminExport(filters)
        const parsed = parseCsv(csv)
        if (cancelled) return
        if (parsed.length > 0) {
          setRows(parsed.slice(1))
        } else {
          setRows([])
        }
        setError('')
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '导出接口调用失败')
          toast('积分流水导出接口调用失败', 'error')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, filters.tenant_id, filters.type])

  const refresh = useCallback(() => setVersion((v) => v + 1), [])
  return { rows, header: [...EXPORT_HEADERS], loading, error, refresh }
}

/** 数据导出按钮（带 token 的 CSV 下载，UIUX §4.6 / FR-707） */
export function ExportButton({ label = '导出 CSV', filters = {} }: { label?: string; filters?: { tenant_id?: string; type?: string } }): React.JSX.Element {
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)

  const doExport = useCallback(async () => {
    setBusy(true)
    try {
      const csv = await api.adminExport(filters)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `informate_export_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast('导出成功', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '导出失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [filters, toast])

  return (
    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void doExport()}>
      {busy ? '导出中…' : label}
    </button>
  )
}

/** 类型 → 中文标签（credit_txn.type） */
export const TXN_TYPE_LABEL: Record<string, string> = {
  recharge: '充值',
  freeze: '冻结',
  settle: '结算',
  unfreeze: '解冻退回',
  adjust: '调账',
}

export const TXN_TYPES = ['recharge', 'freeze', 'settle', 'unfreeze', 'adjust']
