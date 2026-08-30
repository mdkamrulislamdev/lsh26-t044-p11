import { Component, type ReactNode } from 'react'

/**
 * A render crash used to blank the whole page. A dispatcher losing the board
 * mid-shift with no explanation is the worst possible failure here, so the
 * boundary states what happened and offers a way back.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('board crashed', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="p-8">
        <h1 className="display text-[20px]" style={{ color: 'var(--color-flag)' }}>
          The board stopped
        </h1>
        <p className="mt-2 max-w-prose text-[13px] leading-[19px]">
          Something went wrong while drawing the plan. Nothing on the server changed — reloading
          rebuilds the board from the last generated plan.
        </p>
        <p className="mono mt-2 text-[12px] text-muted">{this.state.error.message}</p>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-4 bg-ink px-3.5 py-2 text-[13px] font-medium text-paper"
        >
          Reload the board
        </button>
      </div>
    )
  }
}
