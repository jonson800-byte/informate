import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import { useApp } from '../state/AppContext'
import type { ScenarioDeployment, TenantInfo } from '../api/types'
import { DEFAULT_PRICES, PRICE_KEYS } from '../api/types'
import LeftPanel from './LeftPanel'
import ChatPanel, { type ChatMessageUI, type SessionState } from './ChatPanel'
import ArtifactsPanel, { type ArtifactItem } from './ArtifactsPanel'
import TrialGuide from './TrialGuide'
import RechargeModal from './RechargeModal'
import TxnsModal from './TxnsModal'
import FrozenPage from './FrozenPage'

export interface WorkspaceData {
  tenant: { name: string; industry: string; status: string; balance: number; trial_remaining: number }
  scenarios: ScenarioDeployment[]
  prices: Record<string, string>
}

export interface PerScenarioState {
  session: SessionState
  artifacts: ArtifactItem[]
}

/** 本地持久化 key（场景会话/产出物跨刷新保留；后端无会话/产出物列表接口，前端本地维护） */
const convKey = (tenantId: string, depId: string) => `informate_conv_${tenantId}_${depId}`
const artKey = (tenantId: string, depId: string) => `informate_artifacts_${tenantId}_${depId}`

function loadJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * T9 三栏工作台（UIUX §2）
 * - 顶栏：Logo · 租户名+行业 · 试用/正式徽标 · 用户菜单
 * - 左栏 240px 场景列表 + 余额卡；中栏 Chat（SSE 流式）；右栏 360px 产出物面板
 * - T10：3 步试用引导 / 充值弹窗 / 冻结整页 / 20·50 轮提示 / 欠费琥珀预警 / AI 标识与试用水印
 */
export default function Workspace(): React.JSX.Element {
  const { user, tenant, logout, toast, refreshTenant } = useApp()
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [activeDepId, setActiveDepId] = useState<string>('')
  const [states, setStates] = useState<Record<string, PerScenarioState>>({})
  const statesRef = useRef<Record<string, PerScenarioState>>({})
  useEffect(() => {
    statesRef.current = states
  }, [states])
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [txnsOpen, setTxnsOpen] = useState(false)
  const [isNarrow, setIsNarrow] = useState(false)
  const [narrowView, setNarrowView] = useState<'scenes' | 'chat' | 'artifacts'>('chat')
  // 窄屏监听（UIUX §2.1 兜底：≤1024px 三步切换导航）
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1024px)')
    const on = () => setIsNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  // 恢复所有场景的会话/产出物（刷新后 localStorage → state，R1 接线）+ 默认激活第一个
  useEffect(() => {
    if (!workspace) return
    workspace.scenarios.forEach((sc) => ensureStateRef.current?.(sc.id))
    setActiveDepId((prev) => prev || workspace.scenarios[0]?.id || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])
  const [guideOpen, setGuideOpen] = useState(false)
  const [balanceVersion, setBalanceVersion] = useState(0) // 触发余额重读
  const loadedRef = useRef(false)

  const tenantStatus = (workspace?.tenant.status ?? tenant?.status ?? 'active') as TenantInfo['status']
  const isTrial = tenantStatus === 'trial'
  const isOwner = user?.role === 'owner'

  const prices = useMemo(() => workspace?.prices ?? {}, [workspace])
  const priceOf = useCallback(
    (key: string, fallback: number) => {
      const v = Number(prices[key])
      return Number.isFinite(v) && v > 0 ? v : fallback
    },
    [prices],
  )
  const sessionPrice = priceOf(PRICE_KEYS.session, DEFAULT_PRICES.session)
  const imagePrice = priceOf(PRICE_KEYS.image, DEFAULT_PRICES.image)
  const imageDisplayPrice = DEFAULT_PRICES.imageDisplay // 对外展示价 20（实扣 imagePrice=15）
  const roundExtra = priceOf(PRICE_KEYS.roundExtra, DEFAULT_PRICES.roundExtra)
  const roundLimit = priceOf(PRICE_KEYS.roundLimit, DEFAULT_PRICES.roundLimit)

  const activeDeployment = useMemo(
    () => workspace?.scenarios.find((s) => s.id === activeDepId) ?? workspace?.scenarios[0] ?? null,
    [workspace, activeDepId],
  )

  const loadWorkspace = useCallback(async () => {
    try {
      const [ws, sc] = await Promise.all([api.workspace(), api.scenarios()])
      setWorkspace({ tenant: ws.workspace.tenant, scenarios: sc.data, prices: ws.workspace.prices })
      setLoadError('')
      // 同步租户状态（余额/试用剩余）
      void refreshTenant()
      return { ws, sc }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : '后端服务不可用')
      return null
    }
  }, [refreshTenant])

  // 初始加载
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    void loadWorkspace()
  }, [loadWorkspace])

  // 余额/状态变化后刷新工作台（充值、轮次结算、生图冻结后调用 bump）
  const refreshBalance = useCallback(() => {
    setBalanceVersion((v) => v + 1)
  }, [])
  useEffect(() => {
    if (balanceVersion === 0) return
    void loadWorkspace()
  }, [balanceVersion, loadWorkspace])

  // 试用引导：仅员工 + trial + 首次（本地 seen 标记，重登不弹；主账号不展示 FR-503）
  useEffect(() => {
    if (!user || !workspace) return
    if (user.role === 'employee' && workspace.tenant.status === 'trial') {
      const seen = localStorage.getItem(`informate_guide_${user.id}`)
      if (!seen) setGuideOpen(true)
    }
  }, [user, workspace])

  const finishGuide = useCallback(() => {
    if (user) localStorage.setItem(`informate_guide_${user.id}`, '1')
    setGuideOpen(false)
  }, [user])

  // ---------- 会话状态管理 ----------
  const ensureStateRef = useRef<typeof ensureState | null>(null)
  const ensureState = useCallback(
    (depId: string): PerScenarioState => {
      let cur = states[depId]
      if (!cur) {
        const savedConv = tenant ? loadJSON<string>(convKey(tenant.id, depId)) : null
        cur = {
          session: { convId: savedConv ?? '', messages: [], turns: 0, busy: false, locked: false },
          artifacts: tenant ? (loadJSON<ArtifactItem[]>(artKey(tenant.id, depId)) ?? []) : [],
        }
        setStates((prev) => ({ ...prev, [depId]: cur! }))
      }
      return cur
    },
    [states, tenant],
  )
  ensureStateRef.current = ensureState

  const updateState = useCallback((depId: string, patch: Partial<PerScenarioState>) => {
    setStates((prev) => {
      const cur = prev[depId]
      if (!cur) return prev
      return { ...prev, [depId]: { ...cur, ...patch } }
    })
  }, [])

  const updateSession = useCallback(
    (
      depId: string,
      patch:
        | Partial<SessionState>
        | ((prev: SessionState) => Partial<SessionState>),
    ) => {
      setStates((prev) => {
        const cur = prev[depId]
        const base: SessionState = cur?.session ?? { convId: '', messages: [], turns: 0, busy: false, locked: false }
        const applied = typeof patch === 'function' ? patch(base) : patch
        return { ...prev, [depId]: { session: { ...base, ...applied }, artifacts: cur?.artifacts ?? [] } }
      })
    },
    [],
  )

  const persistConv = useCallback(
    (depId: string, convId: string) => {
      if (tenant) localStorage.setItem(convKey(tenant.id, depId), convId)
    },
    [tenant],
  )

  const persistArtifacts = useCallback(
    (depId: string, artifacts: ArtifactItem[]) => {
      if (tenant) localStorage.setItem(artKey(tenant.id, depId), JSON.stringify(artifacts))
    },
    [tenant],
  )

  const addArtifact = useCallback(
    (depId: string, artifact: ArtifactItem) => {
      setStates((prev) => {
        const cur = prev[depId]
        return { ...prev, [depId]: { ...cur, artifacts: [artifact, ...(cur?.artifacts ?? [])] } }
      })
      // 持久化在 updater 外（副作用不进 render；QuotaExceeded 降级不白屏）
      if (tenant) {
        try {
          const cur = statesRef.current[depId]
          const next = [...(cur?.artifacts ?? []), artifact]
          localStorage.setItem(artKey(tenant.id, depId), JSON.stringify(next))
        } catch {
          /* localStorage 满/不可用：降级为仅内存 */
        }
      }
    },
    [tenant],
  )

  const patchArtifact = useCallback(
    (depId: string, artifactId: string, patch: Partial<ArtifactItem>) => {
      setStates((prev) => {
        const cur = prev[depId]
        if (!cur) return prev
        return { ...prev, [depId]: { ...cur, artifacts: cur.artifacts.map((a) => (a.id === artifactId ? { ...a, ...patch } : a)) } }
      })
      if (tenant) {
        try {
          const cur = statesRef.current[depId]
          if (!cur) return
          const artifacts = cur.artifacts.map((a) => (a.id === artifactId ? { ...a, ...patch } : a))
          localStorage.setItem(artKey(tenant.id, depId), JSON.stringify(artifacts))
        } catch {
          /* 降级为仅内存 */
        }
      }
    },
    [tenant],
  )

  // ---------- 新开对话（FR-104：清空消息流不弹确认，历史后台保留） ----------
  const newConversation = useCallback(
    (depId?: string) => {
      const dep = workspace?.scenarios.find((s) => s.id === (depId ?? activeDepId))
      if (!dep || !tenant) return
      const fresh: SessionState = { convId: '', messages: [], turns: 0, busy: false, locked: false }
      updateSession(dep.id, fresh)
      persistConv(dep.id, '')
      toast('已新开对话', 'success')
    },
    [workspace, activeDepId, tenant, updateSession, persistConv, toast],
  )

  /** 确保会话存在（POST /credit/conversations 创建并冻结 10；trial 扣次数；unit=image 不冻会话费） */
  const ensureConversation = useCallback(
    async (dep: ScenarioDeployment): Promise<string> => {
      const cur = states[dep.id]?.session
      if (cur?.convId) return cur.convId
      const convId = uid()
      const res = await api.createConversation({
        scenario_id: dep.scenario_id,
        conversation_id: convId,
        idempotency_key: `conv:${convId}`,
      })
      updateSession(dep.id, { convId: res.conversation.id })
      persistConv(dep.id, res.conversation.id)
      refreshBalance()
      return res.conversation.id
    },
    [states, updateSession, persistConv, refreshBalance],
  )

  // ---------- 切换场景：恢复该场景会话（FR-104 各场景历史独立） ----------
  const switchScenario = useCallback(
    (depId: string) => {
      setActiveDepId(depId)
      const cur = ensureState(depId)
      // 该场景已有本地消息 → 直接恢复
      if (cur.session.messages.length > 0) return
      // 否则：若已存在会话 id，尝试从后端加载历史（GET /chat/messages?conversation_id=）
      const convId = cur.session.convId
      if (convId) {
        void (async () => {
          try {
            const hist = await api.chatHistory(convId)
            const msgs: ChatMessageUI[] = hist.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              round_no: m.round_no,
              credit_charged: m.credit_charged,
            }))
            updateSession(depId, { messages: msgs, turns: Math.max(...msgs.map((m) => m.round_no ?? 0), 0) })
          } catch {
            /* 历史加载失败静默（如会话已被结算） */
          }
        })()
      }
    },
    [states, updateSession],
  )

  // ---------- 跨场景传递（FR-403/404；试用期隐藏） ----------
  // 真实实现：目标场景新建会话 → 将产出物元数据作为用户消息 POST /chat/messages（落库+计费+审计，FR-405）
  // 目标仅限对话类场景（pricing.unit !== 'image'，生图场景不接收文本传递）；由 TransferModal 过滤
  const transferArtifact = useCallback(
    async (artifact: ArtifactItem, targetDep: ScenarioDeployment) => {
      try {
        const targetConvId = await ensureConversation(targetDep)
        const sourceName = workspace?.scenarios.find((s) => s.id === artifact.deployment_id)?.display_name ?? '来源场景'
        const metaLines = [
          `[跨场景传递] 来自「${sourceName}」的产出物`,
          `类型：${artifact.type === 'image' ? '图片' : '文本'}`,
          artifact.prompt ? `提示词：${artifact.prompt}` : '',
          artifact.type === 'text' && artifact.content ? `内容：\n${artifact.content}` : '',
          artifact.type === 'image' ? '图片文件保留在来源场景产出物面板，可返回查看/下载。' : '',
        ].filter(Boolean)
        const content = metaLines.join('\n').slice(0, 4000) // chat content maxLength=4000
        // 目标会话本地先展示用户消息（真实发送完成后由 round_complete 补助手回复）
        const userMsg: ChatMessageUI = { id: uid(), role: 'user', content }
        const prev = states[targetDep.id]?.session?.messages ?? []
        updateSession(targetDep.id, { messages: [...prev, userMsg] })
        setActiveDepId(targetDep.id)
        // 真实发送：走 SSE /chat/messages（目标会话落库、计费、审计）
        let acc = ''
        await api.chatStream(targetConvId, content, (ev) => {
          if (ev.event === 'delta') acc += ev.text
          if (ev.event === 'round_complete') {
            const reply: ChatMessageUI = {
              id: uid(),
              role: 'assistant',
              content: acc || '(空回复)',
              round_no: ev.complete.turns ?? 0,
              credit_charged: ev.complete.credit_charged ?? null,
            }
            updateSession(targetDep.id, (prev) => ({
              messages: [...prev.messages, userMsg, reply],
              turns: ev.complete.turns ?? 0,
            }))
          }
        })
        toast(`已发送至「${targetDep.display_name}」新对话`, 'success')
      } catch (err) {
        toast(err instanceof ApiError ? err.message : '传递失败', 'error')
      }
    },
    [states, workspace, ensureConversation, updateSession, toast],
  )

  // ---------- 冻结整页 ----------
  if (tenantStatus === 'paused' || tenantStatus === 'expired') {
    return (
      <>
        <FrozenPage
          status={tenantStatus}
          isOwner={isOwner}
          onRecharge={() => setRechargeOpen(true)}
          onLogout={logout}
        />
        {rechargeOpen && (
          <RechargeModal
            prices={workspace?.prices}
            onClose={() => setRechargeOpen(false)}
            onSuccess={() => {
              setRechargeOpen(false)
              toast('充值成功，积分已到账', 'success')
              void refreshTenant()
              refreshBalance()
            }}
          />
        )}
      </>
    )
  }

  if (loadError && !workspace) {
    return (
      <div className="full-page-state">
        <div className="state-card">
          <div className="state-icon">⚠️</div>
          <h2>服务暂不可用</h2>
          <p>{loadError}</p>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => void loadWorkspace()}>重试</button>
            <button className="btn btn-ghost" onClick={logout}>退出登录</button>
          </div>
        </div>
      </div>
    )
  }

  if (!workspace) {
    return (
      <div className="loading-center" style={{ height: '100%' }}>
        <span className="spinner" /> 正在加载工作台…
      </div>
    )
  }

  const effectiveDep = activeDeployment ?? workspace.scenarios[0] ?? null

  return (
    <div className="workspace">
      {/* 顶栏 */}
      <header className="topbar">
        <div className="topbar-brand">
          <span className="logo">I</span>
          <span>Informate</span>
        </div>
        <div className="topbar-center">
          <span className="tenant-name">{workspace.tenant.name}</span>
          <span className="badge badge-active">{workspace.tenant.industry}</span>
          {isTrial ? (
            <span className="badge badge-trial">试用中 · 剩余 {workspace.tenant.trial_remaining} 次会话</span>
          ) : (
            <span className="badge badge-active">正式版</span>
          )}
        </div>
        <div className="topbar-right">
          {user && <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{user.name}（{user.role === 'owner' ? '主账号' : '员工'}）</span>}
          <button className="btn btn-ghost btn-sm" onClick={logout}>退出</button>
        </div>
      </header>

      {isNarrow && (
        <nav className="narrow-steps">
          <button className={narrowView === 'scenes' ? 'active' : ''} onClick={() => setNarrowView('scenes')}>场景</button>
          <button className={narrowView === 'chat' ? 'active' : ''} onClick={() => setNarrowView('chat')}>对话</button>
          <button className={narrowView === 'artifacts' ? 'active' : ''} onClick={() => setNarrowView('artifacts')}>产出物</button>
        </nav>
      )}

      <div className="workspace-body" data-narrow-view={isNarrow ? narrowView : undefined}>
        <LeftPanel
          scenarios={workspace.scenarios}
          activeDepId={effectiveDep?.id ?? ''}
          onSelect={switchScenario}
          tenantStatus={tenantStatus}
          balance={workspace.tenant.balance}
          trialRemaining={workspace.tenant.trial_remaining}
          isOwner={isOwner}
          isTrial={isTrial}
          sessionPrice={sessionPrice}
          imagePrice={imagePrice}
          imageDisplayPrice={imageDisplayPrice}
          onRecharge={() => setRechargeOpen(true)}
          onTxns={() => setTxnsOpen(true)}
        />

        {!effectiveDep && (
          <div className="pane-center empty-deploy">
            <div className="state-card" style={{ margin: 'auto', maxWidth: 380 }}>
              <div className="state-icon">🧩</div>
              <h2>尚未部署任何场景</h2>
              <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
                {isOwner ? '开通行业工作助手后即可开始使用（部署费 ¥500/场景，首单免部署费）' : '请联系企业主账号开通场景'}
              </p>
              <div className="actions">
                {isOwner && (
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      try {
                        await api.deployScenario('industry_work_assistant')
                        toast('已开通「行业工作助手」，正在刷新…', 'success')
                        void loadWorkspace()
                      } catch (err) {
                        toast(err instanceof ApiError ? err.message : '开通失败', 'error')
                      }
                    }}
                  >
                    开通「行业工作助手」
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {effectiveDep && (
          <ChatPanel
            key={effectiveDep.id}
            deployment={effectiveDep}
            session={states[effectiveDep.id]?.session ?? { convId: '', messages: [], turns: 0, busy: false, locked: false }}
            updateSession={(patch) => updateSession(effectiveDep.id, patch)}
            ensureConversation={() => ensureConversation(effectiveDep)}
            isTrial={isTrial}
            roundLimit={roundLimit}
            roundExtra={roundExtra}
            sessionPrice={sessionPrice}
            imagePrice={imagePrice}
            imageDisplayPrice={imageDisplayPrice}
            onNewConversation={() => newConversation(effectiveDep.id)}
            onBalanceChange={refreshBalance}
            onArtifact={(a: ArtifactItem) => {
              addArtifact(effectiveDep.id, a)
            }}
            onArtifactPatch={(id, patch) => patchArtifact(effectiveDep.id, id, patch)}
            onToast={toast}
            isOwner={isOwner}
            onRecharge={() => setRechargeOpen(true)}
          />
        )}

        <ArtifactsPanel
          deploymentId={effectiveDep?.id ?? ''}
          state={states[effectiveDep?.id ?? ''] ?? { session: { convId: '', messages: [], turns: 0, busy: false, locked: false }, artifacts: [] }}
          isTrial={isTrial}
          imagePrice={imagePrice}
          imageDisplayPrice={imageDisplayPrice}
          targets={workspace.scenarios}
          onRegenerate={async (a) => {
            if (!effectiveDep) return
            // 重新生成走全新任务（FR-303）：冻结 → 执行 → 轮询（原卡片保留）
            const newId = uid()
            addArtifact(effectiveDep.id, {
              id: newId,
              type: 'image',
              scenario_id: effectiveDep.scenario_id,
              deployment_id: effectiveDep.id,
              status: 'pending',
              title: a.prompt ? a.prompt.slice(0, 40) : '重新生成',
              prompt: a.prompt,
              created_at: new Date().toISOString(),
              trial: isTrial,
              conversation_id: states[effectiveDep.id]?.session.convId ?? '',
            })
            try {
              await api.freezeImageTask({ task_id: newId, scenario_id: effectiveDep.scenario_id })
              const ex = await api.executeImageTask(newId, a.prompt ?? undefined)
              if (ex.status === 'blocked') {
                patchArtifact(effectiveDep.id, newId, { status: 'failed', fail_reason: ex.reason ?? '提示词未通过合规检查' })
                toast(ex.message, 'warn')
                return
              }
              pollImageTask(newId, (p) => patchArtifact(effectiveDep.id, newId, p))
            } catch (err) {
              patchArtifact(effectiveDep.id, newId, {
                status: 'failed',
                fail_reason: err instanceof ApiError ? err.message : '生图失败',
              })
            } finally {
              refreshBalance()
            }
          }}
          onTransfer={transferArtifact}
        />
      </div>

      {rechargeOpen && (
        <RechargeModal
          prices={workspace?.prices}
          onClose={() => setRechargeOpen(false)}
          onSuccess={() => {
            setRechargeOpen(false)
            toast('充值成功，积分已到账', 'success')
            void refreshTenant()
            refreshBalance()
          }}
        />
      )}

      {guideOpen && <TrialGuide onFinish={finishGuide} onSkip={finishGuide} />}
    </div>
  )
}

/** 生图任务轮询（GET /image-tasks/:id，FR-302）；返回取消函数 */
export function pollImageTask(taskId: string, onUpdate: (patch: Partial<ArtifactItem>) => void): () => void {
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
