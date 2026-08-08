import React, { useState } from 'react'
import type { ScenarioDeployment } from '../api/types'
import type { ArtifactItem } from './ArtifactsPanel'

interface Props {
  artifact: ArtifactItem
  currentDeploymentId: string
  /** 目标场景（已部署 active 的其他场景，来自 GET /api/v1/scenarios） */
  targets: ScenarioDeployment[]
  onClose: () => void
  onConfirm: (target: ScenarioDeployment) => void
}

/**
 * 跨场景传递选择器（FR-402/403，AC-403）
 * 目标 = 已部署的其他 active 对话场景（未部署不出现；生图场景不接收文本传递 → 禁用标注）；试用期整体隐藏（由父层控制不渲染入口）
 * 确认后 Workspace.transferArtifact 在目标场景新建会话并真实发送（POST /chat/messages，落库+计费+审计 FR-405）
 */
export default function TransferModal({ artifact, currentDeploymentId, targets, onClose, onConfirm }: Props): React.JSX.Element {
  const [selectedId, setSelectedId] = useState('')
  const available = targets.filter((t) => t.id !== currentDeploymentId && t.meta?.pricing.unit !== 'image')

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>发送到其他场景</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
            将产出物「{artifact.title}」发送至目标场景新对话，目标助手将基于元数据继续工作
          </div>
          {available.length === 0 && (
            <div className="artifact-empty">暂无其他可用场景（需先部署并启用）</div>
          )}
          {available.map((t) => (
            <div
              key={t.id}
              className={`transfer-target ${selectedId === t.id ? 'selected' : ''}`}
              onClick={() => setSelectedId(t.id)}
            >
              <span className="scenario-icon">{t.meta?.emoji ?? '🧩'}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{t.display_name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {t.meta?.pricing.unit === 'image' ? '生图场景' : '对话场景'}
                </div>
              </div>
            </div>
          ))}
          <button
            className="btn btn-primary btn-block"
            disabled={!selectedId}
            onClick={() => {
              const target = available.find((t) => t.id === selectedId)
              if (target) onConfirm(target)
            }}
          >
            确认发送
          </button>
        </div>
      </div>
    </div>
  )
}
