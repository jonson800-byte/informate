import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { ScenarioDeployment } from '../api/types'
import type { ArtifactItem } from './ArtifactsPanel'

export interface ChatMessageUI {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  round_no?: number | null
  credit_charged?: number | null
  error?: boolean
  streaming?: boolean
}

export interface SessionState {
  convId: string
  messages: ChatMessageUI[]
  turns: number
  busy: boolean
  /** 50 轮上限锁定（第 51 轮被拦截后输入框禁用） */
  locked: boolean
}

/** 会话状态更新：支持函数式更新（prev → patch），保证 SSE 增量不丢帧 */
export type SessionUpdater = (patch: Partial<SessionState> | ((prev: SessionState) => Partial<SessionState>)) => void

interface Props {
  deployment: ScenarioDeployment
  session: SessionState
  updateSession: SessionUpdater
  ensureConversation: () => Promise<string>
  isTrial: boolean
  roundLimit: number
  roundExtra: number
  sessionPrice: number
  imagePrice: number
  imageDisplayPrice: number
  onNewConversation: () => void
  onBalanceChange: () => void
  onArtifact: (a: ArtifactItem) => void
  onArtifactPatch: (id: string, patch: Partial<ArtifactItem>) => void
  onToast: (msg: string, type?: 'info' | 'success' | 'error' | 'warn') => void
  isOwner: boolean
  onRecharge: () => void
}

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 中栏 Chat（UIUX §2.3）
 * - 会话型场景：POST /chat/messages SSE 流式渲染（delta / round_hint / round_complete / error）
 * - 生图型场景：冻结 15 → execute 入队 → 轮询状态（异步 Job，不阻塞对话 FR-303/NFR-15）
 * - 完整回复前禁发送；第 51 轮拦截提示新开对话（429 ROUND_LIMIT_EXCEEDED）
 * - 输入侧合规拦截（400 COMPLIANCE_BLOCKED）显示后端 reason
 * - FR-209 合规提示条常驻；AI 消息带「AI」徽标；文本产出物附 AI 生成小字
 */
export default function ChatPanel({
  deployment,
  session,
  updateSession,
  ensureConversation,
  isTrial,
  roundLimit,
  roundExtra,
  sessionPrice,
  imagePrice,
  imageDisplayPrice,
  onNewConversation,
  onBalanceChange,
  onArtifact,
  onArtifactPatch,
  onToast,
    isOwner,
    onRecharge,
}: Props): React.JSX.Element {
  const [input, setInput] = useState('')
  const [streamingTextId, setStreamingTextId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const isImageScenario = deployment.meta?.pricing.unit === 'image'
  const stopPollRef = useRef<(() => void) | null>(null)
  /** SSE 累积文本（functional update 引用，避免闭包丢失增量） */
  const streamBufRef = useRef<Record<string, string>>({})

  // 自动滚动到底部
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [session.messages, streamingTextId])

  useEffect(() => {
    return () => {
      stopPollRef.current?.()
    }
  }, [])

  const appendMessages = useCallback(
    (items: ChatMessageUI[]) => {
      updateSession((prev) => ({ messages: [...prev.messages, ...items] }))
    },
    [updateSession],
  )

  const patchMessage = useCallback(
    (msgId: string, patch: Partial<ChatMessageUI>) => {
      updateSession((prev) => ({
        messages: prev.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
      }))
    },
    [updateSession],
  )

  // ---------- 会话型：SSE 流式对话 ----------
  const sendChat = useCallback(
    async (rawContent: string) => {
      const convId = await ensureConversation()
      const userMsg: ChatMessageUI = { id: uid(), role: 'user', content: rawContent }
      const aiId = uid()
      streamBufRef.current[aiId] = ''
      appendMessages([userMsg, { id: aiId, role: 'assistant', content: '', streaming: true }])
      setStreamingTextId(aiId)
      updateSession({ busy: true })
      let completed = false
      try {
        await api.chatStream(convId, rawContent, (ev) => {
          if (ev.event === 'delta') {
            streamBufRef.current[aiId] += ev.text
            patchMessage(aiId, { content: streamBufRef.current[aiId] })
          } else if (ev.event === 'round_hint') {
            appendMessages([{ id: uid(), role: 'system', content: ev.hint.message }])
          } else if (ev.event === 'round_complete') {
            completed = true
            const turns = ev.complete.turns
            const charged = ev.complete.credit_charged
            updateSession((prev) => {
              const messages = prev.messages.map((m) =>
                m.id === aiId ? { ...m, streaming: false, round_no: turns, credit_charged: charged } : m,
              )
              return { turns, messages }
            })
            onBalanceChange()
            // 回复即文本产出物（UIUX §5.5：文本产出物附 AI 生成小字）
            const finalText = streamBufRef.current[aiId] ?? ''
            if (finalText) {
              onArtifact({
                id: aiId,
                type: 'text',
                scenario_id: deployment.scenario_id,
                deployment_id: deployment.id,
                status: 'success',
                title: finalText.split('\n')[0].slice(0, 40) || 'AI 生成内容',
                content: finalText,
                created_at: new Date().toISOString(),
                trial: isTrial,
                conversation_id: convId,
              })
            }
            // 50 轮上限（FR-205/G15）：达上限锁定输入，提示新开对话
            if (turns >= roundLimit) {
              updateSession((prev) => ({
                locked: true,
                messages: [
                  ...prev.messages,
                  { id: uid(), role: 'system', content: `已达单会话 ${roundLimit} 轮上限，下一轮将无法发送，建议新开对话`, error: true },
                ],
              }))
            }
          } else if (ev.event === 'error') {
            patchMessage(aiId, { streaming: false, error: true, content: ev.error.message })
          }
        })
      } catch (err) {
        // 非 SSE 业务错误：输入侧合规拦截 / 轮次上限 / 余额不足等（后端错误格式 {code,message,details}）
        const e = err instanceof ApiError ? err : null
        const code = e?.code ?? 'UNKNOWN'
        const message = e?.message ?? '发送失败，请重试'
        updateSession((prev) => ({
          messages: [...prev.messages, { id: uid(), role: 'system', content: message, error: true }],
        }))
        if (code === 'ROUND_LIMIT_EXCEEDED') {
          updateSession({ locked: true })
          onToast(`已达单会话 ${roundLimit} 轮上限，请新开对话`, 'warn')
        } else if (code === 'COMPLIANCE_BLOCKED') {
          onToast('内容未通过医美合规检查，已拦截（不扣积分）', 'warn')
        } else if (code === 'TRIAL_LIMIT_EXCEEDED') {
          if (isOwner) {
            onToast('试用已用尽：充值即转正式版（水印移除、解锁跨场景传递）', 'warn')
            onRecharge()
          } else {
            onToast('试用已用尽，请联系企业主账号开通正式版', 'error')
          }
        } else if (code === 'INSUFFICIENT_BALANCE') {
          if (isOwner) {
            onToast('余额不足，已打开充值窗口', 'warn')
            onRecharge()
          } else {
            onToast('余额不足，请联系企业主账号充值', 'error')
          }
        }
      } finally {
        updateSession({ busy: false })
        setStreamingTextId(null)
        delete streamBufRef.current[aiId]
        if (completed) onBalanceChange()
      }
    },
    [ensureConversation, appendMessages, patchMessage, updateSession, deployment, isTrial, roundLimit, onBalanceChange, onArtifact, onToast, session, isOwner, onRecharge],
  )

  // ---------- 生图型：冻结 → 执行 → 轮询（FR-301~304） ----------
  const sendImage = useCallback(
    async (prompt: string) => {
      const userMsg: ChatMessageUI = { id: uid(), role: 'user', content: prompt }
      appendMessages([
        userMsg,
        { id: uid(), role: 'system', content: `已提交生图任务（${imageDisplayPrice} 积分，实扣 ${imagePrice}），生成中…` },
      ])
      updateSession({ busy: true })
      const taskId = uid()
      try {
        let convId = session.convId
        if (!convId) convId = await ensureConversation()
        await api.freezeImageTask({ task_id: taskId, scenario_id: deployment.scenario_id })
        onBalanceChange()
        const ex = await api.executeImageTask(taskId, prompt)
        if (ex.status === 'blocked') {
          appendMessages([
            {
              id: uid(),
              role: 'system',
              content: `提示词未通过合规检查：${ex.reason ?? '命中医美红线（医疗广告审查）'}。已解冻不扣费，请修改后重试`,
              error: true,
            },
          ])
          onToast('生图已拦截（不扣积分），请修改提示词', 'warn')
          return
        }
        const art: ArtifactItem = {
          id: taskId,
          type: 'image',
          scenario_id: deployment.scenario_id,
          deployment_id: deployment.id,
          status: ex.status === 'success' ? 'success' : 'pending',
          title: prompt.slice(0, 40),
          prompt,
          created_at: new Date().toISOString(),
          trial: isTrial,
          conversation_id: convId,
        }
        onArtifact(art)
        if (ex.status !== 'success') {
          stopPollRef.current?.()
          stopPollRef.current = poll(taskId, (patch) => {
            onArtifactPatch(taskId, patch)
            if (patch.status === 'success' || patch.status === 'failed') {
              appendMessages([
                {
                  id: uid(),
                  role: 'system',
                  content:
                    patch.status === 'success'
                      ? '生图完成，产出物已加入右侧面板'
                      : `生图失败：${patch.fail_reason ?? '未知原因'}（积分已原子退回）`,
                  error: patch.status === 'failed',
                },
              ])
              onBalanceChange()
            }
          })
        } else {
          onBalanceChange()
        }
      } catch (err) {
        const e = err instanceof ApiError ? err : null
        appendMessages([{ id: uid(), role: 'system', content: e?.message ?? '生图提交失败，请重试', error: true }])
        if (e?.code === 'INSUFFICIENT_BALANCE' || e?.code === 'TRIAL_LIMIT_EXCEEDED') {
          if (isOwner) {
            onToast(e.code === 'INSUFFICIENT_BALANCE' ? '余额不足，已打开充值窗口' : '试用已用尽：充值即转正式版', 'warn')
            onRecharge()
          } else {
            onToast(e.code === 'INSUFFICIENT_BALANCE' ? '余额不足，请联系企业主账号充值' : '试用已用尽，请联系企业主账号开通正式版', 'error')
          }
        }
      } finally {
        updateSession({ busy: false })
      }
    },
    [appendMessages, updateSession, deployment, imagePrice, imageDisplayPrice, isTrial, session, ensureConversation, onArtifact, onArtifactPatch, onBalanceChange, onToast, isOwner, onRecharge],
  )

  const send = useCallback(async () => {
    const content = input.trim()
    if (!content || session.busy || session.locked) return
    setInput('')
    if (isImageScenario) await sendImage(content)
    else await sendChat(content)
  }, [input, session.busy, session.locked, isImageScenario, sendChat, sendImage])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const canSend = !session.busy && !session.locked && input.trim().length > 0
  const atLimit = session.locked || session.turns >= roundLimit
  const nextRoundCosts = !isImageScenario && !atLimit && session.turns >= 20 && !session.busy

  const complianceBanner = isImageScenario
    ? '生成图片不得用于前后对比等医疗效果承诺（FR-209）'
    : '内容生成需人工审核，取得《医疗广告审查证明》后方可投放（FR-209）'

  const suggestions = isImageScenario
    ? ['生成一张夏季促销活动海报', '设计一张植发项目宣传图', '生成一张术后护理说明图']
    : ['写一段植发项目朋友圈文案', '整理一份术前术后注意事项清单', '生成夏季促销活动海报需求描述']

  return (
    <main className="pane-center">
      <div className="chat-header">
        <span className="scene-title">{deployment.display_name}</span>
        {isTrial && <span className="badge badge-trial">试用中</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          已用 {session.turns} / {roundLimit} 轮
        </span>
        <button className="btn btn-outline btn-sm" onClick={onNewConversation}>
          ＋ 新开对话
        </button>
      </div>

      <div className="message-list" ref={listRef}>
        {session.messages.length === 0 && (
          <div className="empty-chat">
            <div style={{ fontSize: 15, color: 'var(--text-1)' }}>向「{deployment.display_name}」描述你的需求</div>
            <div>像聊天一样自然表达，AI 会基于行业知识回复你</div>
            <div className="chips">
              {suggestions.map((s) => (
                <button key={s} className="chip" onClick={() => setInput(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {session.messages.map((m) => {
          if (m.role === 'system') {
            return (
              <div key={m.id} className={`system-bar ${m.error ? 'danger' : ''}`}>
                {m.content}
              </div>
            )
          }
          return (
            <div key={m.id} className={`msg-row ${m.role}`}>
              <div className={`msg-avatar ${m.role}`}>
                {m.role === 'user' ? '我' : <span className="badge-ai">AI</span>}
              </div>
              <div className={`msg-bubble ${m.streaming ? 'cursor-blink' : ''}`}>
                {m.content || (m.streaming ? '正在准备你的行业助手…' : '')}
                {m.role === 'assistant' && m.round_no !== null && m.round_no !== undefined && !m.streaming && (
                  <span className="ai-footer">
                    本内容由 AI 生成，需人工审核后使用{m.credit_charged ? ` · 本轮 ${m.credit_charged} 积分` : ''}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="compliance-bar">{complianceBanner}</div>

      <div className="input-area">
        {atLimit ? (
          <div className="system-bar danger" style={{ marginBottom: 8, textAlign: 'center', display: 'block' }}>
            已达单会话 {roundLimit} 轮上限，输入已禁用，建议新开对话
            <button className="btn btn-primary btn-sm" style={{ marginLeft: 8 }} onClick={onNewConversation}>
              新开对话
            </button>
          </div>
        ) : nextRoundCosts ? (
          <div className="input-hint">本轮将消耗 {roundExtra} 积分（超轮）</div>
        ) : null}
        <div className="input-box">
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={session.busy || atLimit}
            placeholder={
              atLimit
                ? `已达单会话 ${roundLimit} 轮上限，请新开对话`
                : session.busy
                  ? 'AI 回复中，完成后可继续发送…'
                  : isImageScenario
                    ? '描述你想生成的图片，例如：夏季促销活动海报'
                    : `向${deployment.display_name}描述你的需求，例如：写一段植发项目朋友圈文案`
            }
          />
          <button className="send-btn" disabled={!canSend} onClick={() => void send()}>
            {session.busy ? '…' : '发送'}
          </button>
        </div>
      </div>
    </main>
  )
}

/** 生图任务轮询（GET /image-tasks/:id，FR-302）；返回取消函数 */
function poll(taskId: string, onUpdate: (patch: Partial<ArtifactItem>) => void): () => void {
  let cancelled = false
  const tick = async (): Promise<void> => {
    if (cancelled) return
    try {
      const st = await api.imageTaskStatus(taskId)
      const patch: Partial<ArtifactItem> = { status: st.status, fail_reason: st.fail_reason }
      if (st.status === 'success' && st.url) patch.url = st.url
      onUpdate(patch)
      if (st.status === 'pending' || st.status === 'processing') {
        window.setTimeout(() => void tick(), 1500)
      }
    } catch {
      window.setTimeout(() => void tick(), 3000)
    }
  }
  void tick()
  return () => {
    cancelled = true
  }
}
