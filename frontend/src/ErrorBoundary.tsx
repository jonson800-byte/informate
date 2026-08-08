import React from 'react'

/**
 * 全局错误边界：捕获渲染/状态更新异常，显示错误卡片而不是白屏（诊断 + 防护）
 */
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 诊断信息打到控制台
    console.error('[Informate ErrorBoundary]', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="full-page-state">
          <div className="state-card">
            <div className="state-icon">⚠️</div>
            <h2>页面出错了</h2>
            <p style={{ fontSize: 13, color: 'var(--text-2)', wordBreak: 'break-all' }}>
              {this.state.error.message}
            </p>
            <div className="actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  this.setState({ error: null })
                  window.location.hash = '/workspace'
                  window.location.reload()
                }}
              >
                刷新重试
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
