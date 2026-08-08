import React, { useState } from 'react'

interface Props {
  onFinish: () => void
  onSkip: () => void
}

const STEPS = [
  {
    title: '第 1 步 · 选场景',
    desc: '从左侧选择你要用的场景，每个场景是一个专属助手。',
    icon: '🧭',
  },
  {
    title: '第 2 步 · 发消息',
    desc: '像聊天一样描述需求，例如：写一段植发项目朋友圈文案。',
    icon: '💬',
  },
  {
    title: '第 3 步 · 看产出物',
    desc: 'AI 生成的图片/文本会自动出现在右侧面板，可下载或发送到其他场景。',
    icon: '🖼️',
  },
]

/**
 * T10 试用引导（UIUX §4.4 / FR-503）
 * 3 步引导：选场景 → 发消息 → 看产出物；可跳过；仅员工首次登录展示（seen 标记在 Workspace 层）
 */
export default function TrialGuide({ onFinish, onSkip }: Props): React.JSX.Element {
  const [step, setStep] = useState(0)
  const cur = STEPS[step]
  const isLast = step === STEPS.length - 1

  return (
    <div className="modal-mask">
      <div className="modal guide-card">
        <div className="modal-body" style={{ padding: 24 }}>
          <div className="guide-illustration">{cur.icon}</div>
          <h3 style={{ fontSize: 17, marginBottom: 8 }}>{cur.title}</h3>
          <p style={{ color: 'var(--text-2)', fontSize: 13 }}>{cur.desc}</p>
          <div className="guide-dots">
            {STEPS.map((_, i) => (
              <span key={i} className={`guide-dot ${i === step ? 'active' : ''}`} />
            ))}
          </div>
          <button
            className="btn btn-primary btn-block"
            onClick={() => (isLast ? onFinish() : setStep((s) => s + 1))}
          >
            {isLast ? '开始使用' : '下一步'}
          </button>
          <div className="guide-skip" onClick={onSkip}>
            跳过，直接开始
          </div>
        </div>
      </div>
    </div>
  )
}
