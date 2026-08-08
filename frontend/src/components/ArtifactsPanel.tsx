import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { downloadWithAuth, previewWithAuth } from '../api/client'
import type { ScenarioDeployment } from '../api/types'
import type { SessionState } from './ChatPanel'
import TransferModal from './TransferModal'
import { useApp } from '../state/AppContext'

/** 产出物（右栏面板；后端无 artifacts 列表接口，前端本地维护；图片 artifact.id = 生图 task_id） */
export interface ArtifactItem {
  id: string
  type: 'image' | 'text'
  scenario_id: string
  deployment_id: string
  status: 'pending' | 'processing' | 'success' | 'failed'
  title: string
  content?: string
  url?: string | null
  prompt?: string | null
  fail_reason?: string | null
  created_at: string
  /** 生成时是否处于试用期 → 卡片角标「含试用水印」（AI 标识永久保留） */
  trial: boolean
  conversation_id: string
}

interface Props {
  deploymentId: string
  state: { session: SessionState; artifacts: ArtifactItem[] }
  isTrial: boolean
  imagePrice: number
  imageDisplayPrice: number
  /** 全部 active 场景（传递选择器目标，FR-403） */
  targets: ScenarioDeployment[]
  onRegenerate: (a: ArtifactItem) => void
  onTransfer: (a: ArtifactItem, targetDep: ScenarioDeployment) => void
}

const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const STATUS_LABEL: Record<ArtifactItem['status'], string> = {
  pending: '排队中',
  processing: '生成中',
  success: '成功',
  failed: '失败',
}

/**
 * 右栏 360px 产出物面板（UIUX §2.4）
 * - 标签：当前对话 | 历史产出（FR-401）
 * - 卡片按 type 渲染：image（缩略图 4:3 + 预览/下载/重新生成/发送到其他场景）、text（标题 + 复制/下载/发送）
 * - 生成中骨架占位 + 状态徽标流转（排队中→生成中→成功/失败，FR-302/303）
 * - 失败卡：原因 + 重试（FR-304）；跨场景传递试用期隐藏（FR-404）
 * - AI 标识永久保留；试用水印仅试用期产物（前端角标仅为提示，标识由后端合成进文件）
 */
export default function ArtifactsPanel({ deploymentId, state, isTrial, imagePrice, imageDisplayPrice, targets, onRegenerate, onTransfer }: Props): React.JSX.Element {
  const { toast } = useApp()
  const [tab, setTab] = useState<'current' | 'history'>('current')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewSrc, setPreviewSrc] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [transferArtifact, setTransferArtifact] = useState<ArtifactItem | null>(null)

  const currentConvId = state.session.convId

  const currentArtifacts = useMemo(
    () =>
      state.artifacts
        .filter((a) => a.deployment_id === deploymentId && a.conversation_id === currentConvId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [state.artifacts, deploymentId, currentConvId],
  )
  const historyArtifacts = useMemo(
    () =>
      state.artifacts
        .filter((a) => a.deployment_id === deploymentId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [state.artifacts, deploymentId],
  )
  const list = tab === 'current' ? currentArtifacts : historyArtifacts

  // 预览：带 token 拉取 blob（下载接口需鉴权 G13）
  const openPreview = useCallback(
    async (a: ArtifactItem) => {
      setPreviewId(a.id)
      setPreviewLoading(true)
      setPreviewSrc('')
      try {
        const src = await previewWithAuth(`/api/v1/artifacts/${encodeURIComponent(a.id)}/download`)
        setPreviewSrc(src)
      } catch {
        toast('预览加载失败', 'error')
      } finally {
        setPreviewLoading(false)
      }
    },
    [toast],
  )

  useEffect(() => {
    return () => {
      if (previewSrc) URL.revokeObjectURL(previewSrc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCopy = async (a: ArtifactItem): Promise<void> => {
    try {
      await navigator.clipboard.writeText(a.content ?? '')
      toast('已复制到剪贴板', 'success')
    } catch {
      toast('复制失败', 'error')
    }
  }

  const downloadImage = (a: ArtifactItem): void => {
    void downloadWithAuth(`/api/v1/artifacts/${encodeURIComponent(a.id)}/download`, `${a.title.slice(0, 30) || 'informate'}.svg`).catch(() =>
      toast('下载失败', 'error'),
    )
  }

  const downloadText = (a: ArtifactItem): void => {
    const blob = new Blob([a.content ?? ''], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const el = document.createElement('a')
    el.href = url
    el.download = `${a.title.slice(0, 20) || 'informate'}.txt`
    el.click()
    URL.revokeObjectURL(url)
  }

  return (
    <aside className="pane-right">
      <div className="artifacts-panel">
        <div className="panel-header">
          <strong style={{ fontSize: 13 }}>产出物</strong>
          <div className="panel-tabs">
            <button className={`panel-tab ${tab === 'current' ? 'active' : ''}`} onClick={() => setTab('current')}>
              当前对话
            </button>
            <button className={`panel-tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
              历史产出
            </button>
          </div>
        </div>
        <div className="artifact-list">
          {list.length === 0 && (
            <div className="artifact-empty">
              对话中生成的图片、文本会自动出现在这里
              <br />
              在中间输入框描述需求即可开始
            </div>
          )}
          {list.map((a) => {
            const isPending = a.status === 'pending' || a.status === 'processing'
            const showThumb = a.type === 'image' && a.status === 'success'
            return (
              <div key={a.id} className={`artifact-card ${a.type}`}>
                {a.type === 'image' && isPending && <div className="skeleton" style={{ aspectRatio: '4 / 3', width: '100%' }} />}
                {showThumb &&
                  (previewId === a.id && previewSrc ? (
                    <img className="thumb" src={previewSrc} alt={a.title} onClick={() => void openPreview(a)} />
                  ) : (
                    <div className="skeleton" style={{ aspectRatio: '4 / 3', width: '100%', cursor: 'pointer' }} onClick={() => void openPreview(a)}>
                      <div
                        style={{
                          width: '100%',
                          height: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--text-3)',
                          fontSize: 12,
                          background: 'linear-gradient(90deg,#f0f2f5 25%,#e5e7eb 50%,#f0f2f5 75%)',
                        }}
                      >
                        {previewId === a.id && previewLoading ? '加载中…' : '点击预览图片'}
                      </div>
                    </div>
                  ))}
                <div className="body">
                  <div className="title">{a.title || '（未命名产出物）'}</div>
                  <div className="time">
                    {fmtTime(a.created_at)} · <span className={`status-tag ${a.status}`}>{STATUS_LABEL[a.status]}</span>
                  </div>
                  <div className="badges">
                    <span className="badge badge-ai">AI 生成</span>
                    {a.trial && <span className="badge badge-watermark">含试用水印</span>}
                  </div>
                  {a.type === 'text' && a.content && (
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-3)',
                        marginTop: 6,
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {a.content}
                    </div>
                  )}
                </div>
                {a.status === 'failed' && a.fail_reason && <div className="fail-reason">失败原因：{a.fail_reason}</div>}
                <div className="actions">
                  {showThumb && (
                    <button className="btn btn-outline btn-sm" onClick={() => void openPreview(a)}>
                      预览
                    </button>
                  )}
                  {showThumb && (
                    <button className="btn btn-outline btn-sm" onClick={() => downloadImage(a)}>
                      下载原图
                    </button>
                  )}
                  {a.type === 'image' && a.status === 'failed' && (
                    <button className="btn btn-danger-outline btn-sm" onClick={() => onRegenerate(a)}>
                      重试
                    </button>
                  )}
                  {showThumb && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        if (window.confirm(`重新生成将消耗 ${imageDisplayPrice} 积分（实扣 ${imagePrice}），是否继续？`)) onRegenerate(a)
                      }}
                    >
                      重新生成
                    </button>
                  )}
                  {a.type === 'text' && a.status === 'success' && (
                    <button className="btn btn-outline btn-sm" onClick={() => void handleCopy(a)}>
                      复制
                    </button>
                  )}
                  {a.type === 'text' && a.status === 'success' && (
                    <button className="btn btn-outline btn-sm" onClick={() => downloadText(a)}>
                      下载
                    </button>
                  )}
                  {/* 跨场景传递：仅正式版显示（FR-404 试用期隐藏） */}
                  {!isTrial && a.status === 'success' && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setTransferArtifact(a)}>
                      发送到其他场景
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 全屏图片预览 */}
      {previewId && (
        <div className="preview-mask" onClick={() => setPreviewId(null)}>
          {previewSrc ? (
            <img className="preview-img" src={previewSrc} alt="预览" />
          ) : (
            <div style={{ color: '#fff' }}>
              {previewLoading ? '图片加载中…' : '图片加载失败'}
            </div>
          )}
        </div>
      )}

      {transferArtifact && (
        <TransferModal
          artifact={transferArtifact}
          currentDeploymentId={deploymentId}
          targets={targets}
          onClose={() => setTransferArtifact(null)}
          onConfirm={(target) => {
            onTransfer(transferArtifact, target)
            setTransferArtifact(null)
          }}
        />
      )}
    </aside>
  )
}
