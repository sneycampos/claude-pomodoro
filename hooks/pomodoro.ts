/**
 * Pomodoro — button-first Pomodoro for Claude Code.
 * Status chip + AbovePrompt band (idle start buttons / running controls) +
 * break Pane + config Pane + /pomodoro.
 *
 * The timer lives in $.state (session-scoped, survives hot reloads). Every
 * change goes through `mutate`, a pure transition applied with `update()` so
 * a tick and a button press can never overwrite each other. The countdown is
 * derived from `endsAt` and the clock, so late ticks do not drift. Settings
 * changed in the config Pane or by /pomodoro config persist in $.store.
 *
 * Color note: hybrid theme — outer AbovePrompt band (and Pane chrome) have NO
 * opaque background (transparent so light/dark/auto match the host). Phase
 * accents stay truecolor hex on borders / labels / progress; muted chrome uses
 * Claude semantic keys (`text`, `inactive`, `subtle`, `promptBorder`).
 */

import { update } from 'claude-code'
import type {
  EngineInterface as Engine,
  On,
  PluginOptions,
  RenderChildren,
  RenderElement,
  Timer,
} from 'claude-code'
import type { TimerConfig, TimerPhase, TimerState } from '../types'

const STATE = { plugin: 'pomodoro', key: 'timer' } as const
/** $.store key holding config saved from the Pane or /pomodoro config. */
const STORE_CONFIG = 'config'
const PANE_ID = 'pomodoro'
const CONFIG_PANE_ID = 'pomodoro-config'

const DEFAULTS: TimerConfig = {
  focusMs: 25 * 60_000,
  breakMs: 5 * 60_000,
  longBreakMs: 15 * 60_000,
  longAfter: 4,
}

/** Accepted ranges for durations (minutes) and the long-break cadence. */
const MAX_MINUTES = 600
const MAX_LONG_AFTER = 12

const COLORS = {
  focus: '#f59e0b',
  break: '#2dd4bf',
  long: '#c084fc',
  paused: '#a3a3a3',
  urgency: '#f43f5e',
} as const

/**
 * Claude theme semantic keys for chrome that should follow light/dark/auto.
 * Phase accents (COLORS) stay as truecolor hex on borders / labels / bar.
 */
const THEME = {
  /** Default frame when phase border is not in play. */
  border: 'promptBorder',
  /** Inactive labels / secondary chrome. */
  inactive: 'inactive',
  /** Muted captions / config line. */
  subtle: 'subtle',
  /** Body text / time when not using a phase hue. */
  text: 'text',
} as const

const ICONS = {
  focus: '●',
  break: '◐',
  long: '◐',
  paused: '⏸',
  idle: '●',
} as const

const BAR_WIDTH = 8
const URGENCY_MS = 60_000
const NARROW_COLS = 60
const BREAK_TOAST_MS = 6_000

/** Quick-start durations shown on the idle band (minutes). */
const IDLE_START_MINUTES = [30, 45, 60] as const

/** Config chip presets (minutes / counts). */
const FOCUS_CHIPS = [15, 25, 45] as const
const BREAK_CHIPS = [3, 5, 10] as const
const LONG_CHIPS = [10, 15, 20] as const
const AFTER_CHIPS = [2, 3, 4] as const

/** Ephemeral cancel handle for this module load; countdown lives in $.state. */
let tick: Timer | undefined

/** Defaults from plugin userConfig, merged at register(). */
let baseConfig: TimerConfig = { ...DEFAULTS }

/** One second up to MAX_MINUTES; fractions of a minute are allowed. */
function isValidMinutes(n: number): boolean {
  return Number.isFinite(n) && n >= 1 / 60 && n <= MAX_MINUTES
}

function isValidLongAfter(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_LONG_AFTER
}

function isValidConfig(v: unknown): v is TimerConfig {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.focusMs === 'number' &&
    typeof c.breakMs === 'number' &&
    typeof c.longBreakMs === 'number' &&
    typeof c.longAfter === 'number' &&
    isValidMinutes(c.focusMs / 60_000) &&
    isValidMinutes(c.breakMs / 60_000) &&
    isValidMinutes(c.longBreakMs / 60_000) &&
    isValidLongAfter(c.longAfter)
  )
}

function sameConfig(a: TimerConfig, b: TimerConfig): boolean {
  return (
    a.focusMs === b.focusMs &&
    a.breakMs === b.breakMs &&
    a.longBreakMs === b.longBreakMs &&
    a.longAfter === b.longAfter
  )
}

function configFromOptions(options: PluginOptions): TimerConfig {
  const minutes = (key: string, fallback: number): number => {
    const v = options[key]
    return typeof v === 'number' && isValidMinutes(v) ? v : fallback
  }
  const after = options.longAfter
  return {
    focusMs: Math.round(minutes('focusMinutes', DEFAULTS.focusMs / 60_000) * 60_000),
    breakMs: Math.round(minutes('breakMinutes', DEFAULTS.breakMs / 60_000) * 60_000),
    longBreakMs: Math.round(
      minutes('longBreakMinutes', DEFAULTS.longBreakMs / 60_000) * 60_000,
    ),
    longAfter:
      typeof after === 'number' && isValidLongAfter(Math.round(after))
        ? Math.round(after)
        : DEFAULTS.longAfter,
  }
}

/**
 * Config saved in $.store, kept with the plugin settings it was made under:
 * when those settings change, they win over the saved config.
 */
type SavedConfig = { config: TimerConfig; base: TimerConfig }

async function loadConfig($: Engine): Promise<TimerConfig> {
  try {
    const saved = (await $.store.get(STORE_CONFIG)) as Partial<SavedConfig> | undefined
    if (
      saved &&
      isValidConfig(saved.config) &&
      isValidConfig(saved.base) &&
      sameConfig(saved.base, baseConfig)
    ) {
      return saved.config
    }
  } catch {
    // Unreadable store — fall back to the plugin settings.
  }
  return baseConfig
}

async function saveConfig($: Engine, config: TimerConfig): Promise<void> {
  try {
    const saved: SavedConfig = { config, base: baseConfig }
    await $.store.set(STORE_CONFIG, saved)
  } catch {
    // Persisting is best effort; the session keeps the new config regardless.
  }
}

async function clearSavedConfig($: Engine): Promise<void> {
  try {
    await $.store.delete(STORE_CONFIG)
  } catch {
    // ignore
  }
}

function idleState(config: TimerConfig = baseConfig): TimerState {
  return {
    phase: 'idle',
    pausedFrom: null,
    remainingMs: 0,
    totalMs: 0,
    endsAt: null,
    focusesDone: 0,
    config,
  }
}

function isTimerState(v: unknown): v is TimerState {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.phase === 'string' &&
    typeof o.remainingMs === 'number' &&
    typeof o.totalMs === 'number' &&
    typeof o.focusesDone === 'number' &&
    isValidConfig(o.config)
  )
}

/** Fills fields added after a state was written (e.g. `endsAt`). */
function normalize(v: unknown): TimerState {
  if (!isTimerState(v)) return idleState()
  return { ...v, endsAt: typeof v.endsAt === 'number' ? v.endsAt : null }
}

async function getTimer($: Engine): Promise<TimerState> {
  const { value } = await $.state.get(STATE)
  return normalize(value)
}

/**
 * Applies a pure transition to the latest state, retrying if another write
 * landed first, and resolves the state it wrote. `fn` may run more than once,
 * so it must not have side effects; callers act on the returned state.
 */
async function mutate(
  $: Engine,
  fn: (t: TimerState) => TimerState,
): Promise<TimerState> {
  return update($, STATE, (v) => fn(normalize(v)))
}

function isRunning(t: TimerState): t is TimerState & { phase: 'focus' | 'break' | 'long' } {
  return t.phase === 'focus' || t.phase === 'break' || t.phase === 'long'
}

function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatMinutes(ms: number): string {
  const mins = ms / 60_000
  return Number.isInteger(mins) ? String(mins) : String(Number(mins.toFixed(2)))
}

function progressBar(remainingMs: number, totalMs: number): string {
  if (totalMs <= 0) return '░'.repeat(BAR_WIDTH)
  const filled = Math.max(
    0,
    Math.min(BAR_WIDTH, Math.round((remainingMs / totalMs) * BAR_WIDTH)),
  )
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

function activePhase(t: TimerState): 'focus' | 'break' | 'long' | null {
  if (isRunning(t)) return t.phase
  if (t.phase === 'paused' && t.pausedFrom) return t.pausedFrom
  return null
}

function isBreakPhase(phase: TimerPhase | null): boolean {
  return phase === 'break' || phase === 'long'
}

function phaseColor(t: TimerState): string {
  if (t.phase === 'paused') return COLORS.paused
  if (t.phase === 'idle') return COLORS.focus
  if (t.remainingMs < URGENCY_MS) return COLORS.urgency
  if (t.phase === 'focus') return COLORS.focus
  if (t.phase === 'long') return COLORS.long
  return COLORS.break
}

function phaseIcon(t: TimerState): string {
  if (t.phase === 'paused') return ICONS.paused
  if (t.phase === 'focus') return ICONS.focus
  if (t.phase === 'break' || t.phase === 'long') return ICONS.break
  return ICONS.idle
}

function focusNumber(t: TimerState): string {
  return `${Math.min(t.focusesDone + 1, t.config.longAfter)}/${t.config.longAfter}`
}

function phaseLabel(t: TimerState): string {
  const active = activePhase(t)
  if (active === 'focus') return `FOCUS ${focusNumber(t)}`
  if (active === 'break') return 'BREAK'
  if (active === 'long') return 'LONG BREAK'
  return 'POMODORO'
}

/** Wide-band headline: break states keep reminding the user to pause. */
function bandHeadline(t: TimerState): string {
  const active = activePhase(t)
  if (active === 'break') return 'BREAK — stretch / water'
  if (active === 'long') return 'LONG BREAK — stretch / water'
  return phaseLabel(t)
}

/** Pane headline: break nudge matching the toast cue. */
function paneHeadline(t: TimerState): string {
  const active = activePhase(t)
  if (active === 'break') return 'Pomodoro break — step away from the keyboard'
  if (active === 'long') return 'Pomodoro long break — step away from the keyboard'
  if (t.phase === 'idle') return 'Pomodoro — pick a focus length'
  return phaseLabel(t)
}

/**
 * Always return a chip, idle included: without a status entry the Desktop
 * app may skip painting the idle AbovePrompt band.
 */
function statusChip(t: TimerState): string {
  const active = activePhase(t)
  if (!active) return 'pomodoro · ready'
  const time = formatMmSs(t.remainingMs)
  const label =
    active === 'focus'
      ? `focus ${focusNumber(t)}`
      : active === 'long'
        ? 'long break'
        : 'break'
  if (t.phase === 'paused') return `pomodoro ${time} · paused · ${label}`
  return `pomodoro ${time} · ${label}`
}

function syncStatus($: Engine, t: TimerState): void {
  $.ui.status(statusChip(t))
}

function ensureTick($: Engine): void {
  if (tick) return
  tick = $.clock.every(1000, () => {
    void onTick($)
  })
}

function stopTick(): void {
  tick?.cancel()
  tick = undefined
}

/** Starts a phase now: the countdown ends `ms` from `now`. */
function running(
  t: TimerState,
  phase: 'focus' | 'break' | 'long',
  ms: number,
  now: number,
): TimerState {
  return {
    ...t,
    phase,
    pausedFrom: null,
    remainingMs: ms,
    totalMs: ms,
    endsAt: now + ms,
  }
}

/**
 * The phase after `t`'s active one ends (or is skipped). A skipped focus
 * counts toward the long break, as a finished one does.
 */
function advance(t: TimerState, now: number): TimerState {
  if (activePhase(t) === 'focus') {
    const focusesDone = t.focusesDone + 1
    const useLong = focusesDone >= t.config.longAfter
    return {
      ...running(
        t,
        useLong ? 'long' : 'break',
        useLong ? t.config.longBreakMs : t.config.breakMs,
        now,
      ),
      focusesDone: useLong ? 0 : focusesDone,
    }
  }
  return running(t, 'focus', t.config.focusMs, now)
}

/** Toasts, panes and the tick that follow a change of phase. */
async function afterTransition(
  $: Engine,
  before: TimerState,
  after: TimerState,
): Promise<void> {
  syncStatus($, after)
  if (after.phase === 'idle') {
    stopTick()
    if (isBreakPhase(activePhase(before))) await closeBreakPane($)
    return
  }
  if (isRunning(after)) ensureTick($)

  const from = activePhase(before)
  const to = activePhase(after)
  if (from === 'focus' && isBreakPhase(to) && after.phase !== 'paused') {
    const long = to === 'long'
    $.ui.toast(
      long
        ? 'Pomodoro long break — step away from the keyboard'
        : 'Pomodoro break — step away from the keyboard',
      { timeoutMs: BREAK_TOAST_MS },
    )
    await openBreakPane($, long ? 'long' : 'break')
  } else if (isBreakPhase(from) && to === 'focus') {
    await closeBreakPane($)
    $.ui.toast('Back to focus', { timeoutMs: BREAK_TOAST_MS })
  }
}

/** Moves the state from `before` to `fn(latest)` and runs what follows it. */
async function transition(
  $: Engine,
  fn: (t: TimerState) => TimerState,
): Promise<{ before: TimerState; after: TimerState }> {
  let before = idleState()
  const after = await mutate($, (t) => {
    before = t
    return fn(t)
  })
  await afterTransition($, before, after)
  return { before, after }
}

async function onTick($: Engine): Promise<void> {
  const now = await $.clock.now()
  await transition($, (t) => {
    if (!isRunning(t) || t.endsAt === null) return t
    const remainingMs = Math.max(0, t.endsAt - now)
    return remainingMs > 0 ? { ...t, remainingMs } : advance(t, now)
  })
}

async function startFocus($: Engine, minutes?: number): Promise<string> {
  const now = await $.clock.now()
  const { after } = await transition($, (t) => {
    // A given length applies to this focus only; the saved config is unchanged.
    const focusMs =
      minutes !== undefined && isValidMinutes(minutes)
        ? Math.round(minutes * 60_000)
        : t.config.focusMs
    return { ...running(t, 'focus', focusMs, now), focusesDone: 0 }
  })
  return `Focus started — ${formatMmSs(after.remainingMs)}`
}

async function pauseTimer($: Engine): Promise<string> {
  const now = await $.clock.now()
  const { before, after } = await transition($, (t) => {
    if (!isRunning(t)) return t
    const remainingMs =
      t.endsAt === null ? t.remainingMs : Math.max(0, t.endsAt - now)
    return { ...t, phase: 'paused', pausedFrom: t.phase, remainingMs, endsAt: null }
  })
  if (before.phase === 'idle') return 'Timer is not running'
  if (before.phase === 'paused') return 'Timer is already paused'
  return `Paused — ${formatMmSs(after.remainingMs)} left`
}

async function resumeTimer($: Engine): Promise<string> {
  const now = await $.clock.now()
  const { before, after } = await transition($, (t) => {
    if (t.phase !== 'paused' || !t.pausedFrom) return t
    return {
      ...t,
      phase: t.pausedFrom,
      pausedFrom: null,
      endsAt: now + t.remainingMs,
    }
  })
  if (before.phase !== 'paused') return 'Timer is not paused'
  return `Resumed — ${formatMmSs(after.remainingMs)} left`
}

/** Pause when running, resume when paused, decided on the latest state. */
async function togglePause($: Engine): Promise<string> {
  const t = await getTimer($)
  return t.phase === 'paused' ? resumeTimer($) : pauseTimer($)
}

async function skipPhase($: Engine): Promise<string> {
  const now = await $.clock.now()
  const { before, after } = await transition($, (t) =>
    activePhase(t) ? advance(t, now) : t,
  )
  if (!activePhase(before)) return 'Timer is not running'
  return `Skipped → ${phaseLabel(after)} ${formatMmSs(after.remainingMs)}`
}

async function stopTimer($: Engine): Promise<string> {
  await transition($, (t) => idleState(t.config))
  return 'Timer stopped'
}

function parseStartMinutes(args: string): number | undefined {
  const parts = args.trim().split(/\s+/)
  if (parts[0] !== 'start') return undefined
  if (parts.length < 2) return undefined
  const n = Number(parts[1])
  return isValidMinutes(n) ? n : undefined
}

function configSummary(c: TimerConfig): string {
  return [
    `focus ${formatMinutes(c.focusMs)}m`,
    `break ${formatMinutes(c.breakMs)}m`,
    `long ${formatMinutes(c.longBreakMs)}m`,
    `after ${c.longAfter}`,
  ].join(' · ')
}

const DURATION_ERROR = `Durations must be between 1 second and ${MAX_MINUTES} minutes`
const LONG_AFTER_ERROR = `after must be a whole number from 1 to ${MAX_LONG_AFTER}`

/**
 * Applies a config change computed from the latest config, shortens the
 * running block when its own length changed, and saves the result.
 */
async function applyConfig(
  $: Engine,
  patchFor: (c: TimerConfig) => Partial<TimerConfig>,
): Promise<string> {
  const now = await $.clock.now()
  let error: string | undefined
  const { after } = await transition($, (t) => {
    error = undefined
    const config: TimerConfig = { ...t.config, ...patchFor(t.config) }
    if (
      !isValidMinutes(config.focusMs / 60_000) ||
      !isValidMinutes(config.breakMs / 60_000) ||
      !isValidMinutes(config.longBreakMs / 60_000)
    ) {
      error = DURATION_ERROR
      return t
    }
    if (!isValidLongAfter(config.longAfter)) {
      error = LONG_AFTER_ERROR
      return t
    }

    const next: TimerState = { ...t, config }
    const active = activePhase(t)
    const lengthMs =
      active === 'focus'
        ? config.focusMs
        : active === 'break'
          ? config.breakMs
          : active === 'long'
            ? config.longBreakMs
            : undefined
    if (lengthMs === undefined || lengthMs === next.totalMs) return next

    const current =
      isRunning(t) && t.endsAt !== null ? Math.max(0, t.endsAt - now) : t.remainingMs
    const remainingMs = Math.min(current, lengthMs)
    return {
      ...next,
      remainingMs,
      totalMs: lengthMs,
      endsAt: isRunning(t) ? now + remainingMs : null,
    }
  })
  if (error) return error
  await saveConfig($, after.config)
  return `Config saved — ${configSummary(after.config)}`
}

async function resetConfig($: Engine): Promise<string> {
  await applyConfig($, () => baseConfig)
  await clearSavedConfig($)
  return `Config reset to plugin settings — ${configSummary(baseConfig)}`
}

const CONFIG_USAGE =
  'usage: /pomodoro config [focus|break|long|after] <n> … | config reset'

async function handleConfig($: Engine, raw: string): Promise<string> {
  const rest = raw.replace(/^config\s*/i, '').trim()
  if (!rest) {
    const t = await getTimer($)
    return `Config — ${configSummary(t.config)}`
  }
  if (rest.toLowerCase() === 'reset') return resetConfig($)

  const tokens = rest.split(/\s+/)
  const patch: Partial<TimerConfig> = {}
  let i = 0
  while (i < tokens.length) {
    let key = tokens[i]!
    let valStr: string | undefined
    if (key.includes('=')) {
      const [k, v] = key.split('=', 2)
      key = k!
      valStr = v
      i += 1
    } else {
      valStr = tokens[i + 1]
      i += 2
    }
    const n = Number(valStr)
    const k = key.toLowerCase()
    if (k === 'after') {
      if (!isValidLongAfter(n)) return LONG_AFTER_ERROR
      patch.longAfter = n
      continue
    }
    if (!isValidMinutes(n)) return valStr === undefined ? CONFIG_USAGE : DURATION_ERROR
    if (k === 'focus') patch.focusMs = Math.round(n * 60_000)
    else if (k === 'break') patch.breakMs = Math.round(n * 60_000)
    else if (k === 'long') patch.longBreakMs = Math.round(n * 60_000)
    else return CONFIG_USAGE
  }
  if (Object.keys(patch).length === 0) return CONFIG_USAGE
  return applyConfig($, () => patch)
}

async function openPane($: Engine): Promise<string> {
  const opened = await $.ui.open({ id: PANE_ID, title: 'Pomodoro', rows: 8 })
  if (!opened.isPlaced) {
    return `Pane opened but not placed yet (${opened.reason ?? 'widen terminal or ask again'})`
  }
  return 'Pomodoro pane open'
}

async function closePane($: Engine): Promise<string> {
  await $.ui.close({ id: PANE_ID })
  return 'Pomodoro pane closed'
}

async function isPaneOpen($: Engine, id: string = PANE_ID): Promise<boolean> {
  try {
    const panes = await $.ui.panes()
    return panes.some((p) => p.id === id)
  } catch {
    return false
  }
}

/**
 * Open the dismissible break Pane (focus + Escape-to-close).
 * Skips if already open. Focus is a request — busy composer still opens
 * the pane without keyboard. Any open failure keeps toast+band only.
 */
async function openBreakPane(
  $: Engine,
  kind: 'break' | 'long',
): Promise<void> {
  try {
    if (await isPaneOpen($)) return
    const title = kind === 'long' ? 'Pomodoro Long Break' : 'Pomodoro Break'
    try {
      await $.ui.open({
        id: PANE_ID,
        title,
        focus: true,
        closeOnEscape: true,
        rows: 8,
      })
    } catch {
      // Focus/open refused hard — retry without focus so the pane still appears.
      await $.ui.open({
        id: PANE_ID,
        title,
        closeOnEscape: true,
        rows: 8,
      })
    }
  } catch {
    // Toast + band already shown — never crash the phase transition.
  }
}

/** Close the break Pane when leaving break (break→focus), if still open. */
async function closeBreakPane($: Engine): Promise<void> {
  try {
    if (!(await isPaneOpen($))) return
    await $.ui.close({ id: PANE_ID })
  } catch {
    // ignore
  }
}

async function openConfigPane($: Engine): Promise<string> {
  try {
    const opened = await $.ui.open({
      id: CONFIG_PANE_ID,
      title: 'Pomodoro Config',
      focus: true,
      closeOnEscape: true,
      rows: 10,
    })
    if (!opened.isPlaced) {
      return `Config pane opened but not placed yet (${opened.reason ?? 'widen terminal or ask again'})`
    }
    return 'Pomodoro config open'
  } catch {
    try {
      await $.ui.open({
        id: CONFIG_PANE_ID,
        title: 'Pomodoro Config',
        closeOnEscape: true,
        rows: 10,
      })
      return 'Pomodoro config open'
    } catch {
      return 'Could not open config pane'
    }
  }
}

async function closeConfigPane($: Engine): Promise<string> {
  try {
    await $.ui.close({ id: CONFIG_PANE_ID })
  } catch {
    // ignore
  }
  return 'Pomodoro config closed'
}

type Kit = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Button: (props: any) => RenderElement
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Text: (props: any) => RenderElement
}

function idleStartButtons($: Engine, kit: Kit, prefix: string): RenderChildren[] {
  const { Button, Text } = kit
  const nodes: RenderChildren[] = []
  const hotkeys = ['1', '2', '3'] as const
  IDLE_START_MINUTES.forEach((mins, i) => {
    if (i > 0) nodes.push(Text({ children: ' ' }))
    nodes.push(
      Button({
        key: `${prefix}start-${mins}`,
        label: `▶ ${mins}`,
        hotkey: hotkeys[i],
        plain: true,
        onPress: () => {
          void startFocus($, mins)
        },
      }),
    )
  })
  nodes.push(Text({ children: '  ' }))
  nodes.push(
    Button({
      key: `${prefix}config`,
      label: '⚙',
      hotkey: 'c',
      plain: true,
      onPress: () => {
        void openConfigPane($)
      },
    }),
  )
  return nodes
}

function runningControlButtons(
  $: Engine,
  kit: Kit,
  t: TimerState,
  prefix: string,
): RenderChildren[] {
  const { Button, Text } = kit
  const pauseLabel = t.phase === 'paused' ? 'resume' : 'pause'
  return [
    Button({
      key: `${prefix}pause`,
      label: pauseLabel,
      hotkey: '1',
      plain: true,
      onPress: () => {
        void togglePause($)
      },
    }),
    Text({ children: '  ' }),
    Button({
      key: `${prefix}skip`,
      label: 'skip',
      hotkey: '2',
      plain: true,
      onPress: () => {
        void skipPhase($)
      },
    }),
    Text({ children: '  ' }),
    Button({
      key: `${prefix}stop`,
      label: 'stop',
      hotkey: '3',
      plain: true,
      onPress: () => {
        void stopTimer($)
      },
    }),
  ]
}

function controlButtons(
  $: Engine,
  kit: Kit,
  t: TimerState,
  prefix: string,
): RenderChildren[] {
  if (t.phase === 'idle') return idleStartButtons($, kit, prefix)
  return runningControlButtons($, kit, t, prefix)
}

function chipRow(
  kit: Kit,
  label: string,
  chips: readonly number[],
  current: number,
  prefix: string,
  onPick: (n: number) => void,
  unit: 'm' | '' = 'm',
): RenderElement {
  const { Box, Text, Button } = kit as Kit & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Box: (props: any) => RenderElement
  }
  const children: RenderChildren[] = [
    Text({
      color: THEME.subtle,
      children: `${label} `,
    }),
  ]
  chips.forEach((n, i) => {
    if (i > 0) children.push(Text({ children: ' ' }))
    const selected = n === current
    children.push(
      Button({
        key: `${prefix}${n}`,
        label: selected ? `[${n}${unit}]` : `${n}${unit}`,
        plain: true,
        onPress: () => onPick(n),
      }),
    )
  })
  return Box({ flexDirection: 'row', alignItems: 'center', children })
}

async function handleCommand($: Engine, rawIn: string): Promise<{ text: string }> {
  const raw = (rawIn ?? '').trim()
  const arg = raw.toLowerCase()
  if (arg === '' || arg === 'status') {
    const t = await getTimer($)
    if (t.phase === 'idle') {
      return {
        text: `Pomodoro idle. Press ▶ 30 / ▶ 45 / ▶ 60 or /pomodoro start [minutes] · ${configSummary(t.config)}`,
      }
    }
    const cue = isBreakPhase(activePhase(t))
      ? ' — step away from the keyboard'
      : ''
    return {
      text: `${phaseLabel(t)}${cue} · ${formatMmSs(t.remainingMs)} · ${t.phase}`,
    }
  }
  if (arg.startsWith('start')) {
    const minutes = parseStartMinutes(arg)
    if (arg !== 'start' && minutes === undefined) {
      return { text: 'usage: /pomodoro start [minutes]' }
    }
    return { text: await startFocus($, minutes) }
  }
  if (arg === 'pause') return { text: await pauseTimer($) }
  if (arg === 'resume') return { text: await resumeTimer($) }
  if (arg === 'skip') return { text: await skipPhase($) }
  if (arg === 'stop') return { text: await stopTimer($) }
  if (arg === 'pane' || arg === 'pane open') {
    return { text: await openPane($) }
  }
  if (arg === 'pane close') return { text: await closePane($) }
  if (arg === 'config' || arg === 'config open') {
    // Bare config opens the button Pane; slash setters still work via args.
    return { text: await openConfigPane($) }
  }
  if (arg === 'config close') return { text: await closeConfigPane($) }
  if (arg.startsWith('config')) {
    return { text: await handleConfig($, raw) }
  }
  return {
    text: 'usage: /pomodoro start [minutes]|pause|resume|skip|stop|config …|pane [close]',
  }
}

export function register(on: On, options: PluginOptions = {}): void {
  baseConfig = configFromOptions(options)

  on('session.start', async ($, e, next) => {
    stopTick()
    // A refused register (e.g. a name clash) must not abort the rest of
    // session.start, or the band never gets its idle state and first draw.
    try {
      await $.command.register({
        name: 'pomodoro',
        description:
          'Pomodoro: start, pause, resume, skip, stop, config, or pane',
        argumentHint:
          '[start [minutes]|pause|resume|skip|stop|config …|pane [close]]',
        immediate: true,
      })
    } catch {
      // Band buttons still work without the slash command.
    }

    // Seed the state with the saved config (or the plugin settings) and write
    // it, so AbovePrompt subscribers draw. A running block survives a reload
    // and keeps counting from its endsAt.
    const config = await loadConfig($)
    const seeded = await mutate($, (t) => ({ ...t, config }))

    if (seeded.phase !== 'idle' && seeded.phase !== 'paused') {
      ensureTick($)
    }
    syncStatus($, seeded)

    // Force AbovePrompt (idle start chips included) to draw on session start.
    // Types: invalidate("ui.render") re-runs cached render hooks; status pin
    // keeps the plugin visible under the prompt. Deferred pass for Desktop
    // bind / hot-reload timing after session.start returns.
    $.ui.invalidate('ui.render')
    $.clock.after(0, async () => {
      syncStatus($, await getTimer($))
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopTick()
    $.ui.status(undefined)
    return next(e)
  })

  on('command.run', { command: 'pomodoro' }, async ($, e) => {
    return handleCommand($, e.args ?? '')
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = await getTimer($)
    if (e.props.hasSurvey) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const color = phaseColor(t)
    const icon = phaseIcon(t)
    const wide = (e.props.bodyColumns ?? 80) >= NARROW_COLS

    // Idle: compact button-first strip — Pomodoro · [▶ 30] [▶ 45] [▶ 60] · [⚙]
    if (t.phase === 'idle') {
      const children: RenderChildren[] = [
        Text({ color, bold: true, children: `${icon} Pomodoro` }),
        Text({ color: THEME.subtle, children: ' · ' }),
        ...idleStartButtons($, { Button, Text }, 'band-'),
      ]
      return Box({
        flexDirection: 'row',
        alignItems: 'center',
        paddingX: 1,
        borderStyle: 'round',
        borderColor: THEME.border,
        children,
      })
    }

    const time = formatMmSs(t.remainingMs)
    const onBreak = isBreakPhase(activePhase(t))
    const children: RenderChildren[] = [
      Text({ color, bold: true, children: `${icon} ` }),
    ]

    if (wide) {
      children.push(
        Text({ color, bold: true, children: bandHeadline(t) }),
        Text({ color: THEME.text, children: `   ${time}   ` }),
        Text({ color, children: progressBar(t.remainingMs, t.totalMs) }),
        Text({ children: '   ' }),
      )
    } else {
      const short =
        onBreak && (activePhase(t) === 'long' || t.pausedFrom === 'long')
          ? 'LONG '
          : onBreak
            ? 'BREAK '
            : ''
      children.push(
        Text({ color, bold: true, children: `${short}${time} ` }),
      )
    }

    children.push(...runningControlButtons($, { Button, Text }, t, 'band-'))

    // One-row compact band — no opaque strip bg (light/dark compatible);
    // phase accents live on border / labels / progress only.
    return Box({
      flexDirection: 'row',
      alignItems: 'center',
      paddingX: 1,
      borderStyle: 'round',
      borderColor: color,
      children,
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const t = await getTimer($)
    const { Box, Text, Button } = $.ui.resolve(e)
    const color = phaseColor(t)
    const icon = phaseIcon(t)
    const time = formatMmSs(t.remainingMs)
    const onBreak = isBreakPhase(activePhase(t))
    const headline = paneHeadline(t)
    const hint = onBreak
      ? `Remaining ${time} — Esc or dismiss to close`
      : t.phase === 'paused'
        ? 'Paused'
        : t.phase === 'focus'
          ? 'Focus block'
          : 'Pick a focus length or open config'

    const paneControls: RenderChildren[] = [
      ...controlButtons($, { Button, Text }, t, 'pane-'),
    ]
    // Dismiss closes the pane only — timer keeps running (Escape does the same).
    paneControls.push(
      Text({ children: '  ' }),
      Button({
        key: 'pane-dismiss',
        label: 'dismiss',
        hotkey: 'd',
        plain: true,
        onPress: () => {
          void $.ui.close({ id: PANE_ID })
        },
      }),
    )

    // Pane chrome: no opaque chassis wash — phase accents on border/text only.
    return Box({
      flexDirection: 'column',
      paddingX: 1,
      paddingY: 1,
      gap: 1,
      borderStyle: 'round',
      borderColor: color,
      children: [
        Box({
          flexDirection: 'row',
          children: [
            Text({ color, bold: true, children: `${icon} ${headline}` }),
          ],
        }),
        Box({
          flexDirection: 'row',
          children: [
            Text({ color: THEME.text, children: `${time}  ` }),
            Text({
              color,
              children: progressBar(t.remainingMs, t.totalMs),
            }),
          ],
        }),
        Text({
          color: onBreak ? COLORS.break : THEME.subtle,
          children: hint,
        }),
        Box({
          flexDirection: 'row',
          children: paneControls,
        }),
        Text({
          color: THEME.subtle,
          children: configSummary(t.config),
        }),
      ],
    })
  })

  on(
    'ui.render',
    { component: 'Pane', requestId: CONFIG_PANE_ID },
    async ($, e) => {
      const t = await getTimer($)
      const kit = $.ui.resolve(e)
      const { Box, Text, Button } = kit
      const focusMin = Math.round(t.config.focusMs / 60_000)
      const breakMin = Math.round(t.config.breakMs / 60_000)
      const longMin = Math.round(t.config.longBreakMs / 60_000)
      const after = t.config.longAfter

      // Steps the latest focus length by whole minutes, so presses made
      // before a redraw all count.
      const bumpFocus = (delta: number) =>
        applyConfig($, (c) => {
          const minutes = Math.round(c.focusMs / 60_000) + delta
          return {
            focusMs: Math.min(MAX_MINUTES, Math.max(1, minutes)) * 60_000,
          }
        })

      return Box({
        flexDirection: 'column',
        paddingX: 1,
        paddingY: 1,
        gap: 1,
        borderStyle: 'round',
        borderColor: THEME.border,
        children: [
          Text({
            color: COLORS.focus,
            bold: true,
            children: '● Pomodoro Config',
          }),
          chipRow(
            kit as Kit & { Box: typeof Box },
            'Focus',
            FOCUS_CHIPS,
            focusMin,
            'cfg-focus-',
            (n) => {
              void applyConfig($, () => ({ focusMs: n * 60_000 }))
            },
          ),
          Box({
            flexDirection: 'row',
            children: [
              Button({
                key: 'cfg-focus-minus',
                label: '−',
                plain: true,
                onPress: () => {
                  void bumpFocus(-1)
                },
              }),
              Text({ children: ' ' }),
              Button({
                key: 'cfg-focus-plus',
                label: '+',
                plain: true,
                onPress: () => {
                  void bumpFocus(1)
                },
              }),
              Text({
                color: THEME.subtle,
                children: `  now ${formatMinutes(t.config.focusMs)}m`,
              }),
            ],
          }),
          chipRow(
            kit as Kit & { Box: typeof Box },
            'Break',
            BREAK_CHIPS,
            breakMin,
            'cfg-break-',
            (n) => {
              void applyConfig($, () => ({ breakMs: n * 60_000 }))
            },
          ),
          chipRow(
            kit as Kit & { Box: typeof Box },
            'Long ',
            LONG_CHIPS,
            longMin,
            'cfg-long-',
            (n) => {
              void applyConfig($, () => ({ longBreakMs: n * 60_000 }))
            },
          ),
          chipRow(
            kit as Kit & { Box: typeof Box },
            'After',
            AFTER_CHIPS,
            after,
            'cfg-after-',
            (n) => {
              void applyConfig($, () => ({ longAfter: n }))
            },
            '',
          ),
          Text({
            color: THEME.subtle,
            children: configSummary(t.config),
          }),
          Box({
            flexDirection: 'row',
            children: [
              Button({
                key: 'cfg-close',
                label: 'close',
                hotkey: 'd',
                plain: true,
                onPress: () => {
                  void $.ui.close({ id: CONFIG_PANE_ID })
                },
              }),
              Text({
                color: THEME.subtle,
                children: '  Esc closes · chips save immediately',
              }),
            ],
          }),
        ],
      })
    },
  )

  // Theme switch (light/dark/auto) → redraw so semantic keys resolve fresh.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny) {
      $.ui.invalidate('ui.render')
    }
    return result
  })
}

export type { TimerPhase, TimerState }

// Constants exposed for the tests; not part of a public API.
export const __tokens = {
  COLORS,
  THEME,
  PANE_ID,
  CONFIG_PANE_ID,
  IDLE_START_MINUTES,
}
