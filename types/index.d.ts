/** Active or idle phase of the Pomodoro timer. */
export type TimerPhase = 'idle' | 'focus' | 'break' | 'long' | 'paused'

/** How long each phase lasts and when a long break is due. */
export type TimerConfig = {
  focusMs: number
  breakMs: number
  longBreakMs: number
  longAfter: number
}

/**
 * Hot-reload-safe timer snapshot held in `$.state`.
 * Countdown lives here — never in module-level variables.
 */
export type TimerState = {
  phase: TimerPhase
  /** Phase restored by resume when `phase` is `paused`. */
  pausedFrom: 'focus' | 'break' | 'long' | null
  /** Time left; frozen while paused, refreshed from `endsAt` while running. */
  remainingMs: number
  /** Duration of the current (or paused) block, for the progress bar. */
  totalMs: number
  /** Epoch ms when the running block ends; `null` while idle or paused. */
  endsAt: number | null
  /**
   * Focuses completed in the current cycle (0 .. longAfter-1).
   * Displayed focus number is `focusesDone + 1` while in focus.
   */
  focusesDone: number
  config: TimerConfig
}

declare module 'claude-code' {
  interface PluginState {
    pomodoro: { timer: TimerState }
  }
}
