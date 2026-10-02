import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { TimerState } from '../types'
import { __tokens } from '../hooks/pomodoro'

type OpenCall = {
  id: string
  title?: string
  focus?: true
  closeOnEscape?: true
  holdToasts?: true
  rows?: number
}

type World = {
  clock: MockClock
  state: () => TimerState
  statuses: () => Array<string | undefined>
  toasts: () => string[]
  opened: () => OpenCall[]
  closed: () => string[]
  registered: () => string[]
  invalidations: () => string[]
  sounds: () => string[]
}

function world(
  on: On,
  opts?: { openThrows?: boolean; store?: Record<string, unknown> },
): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, opts?.store)
  let state: TimerState | undefined
  let version = 0
  const statuses: Array<string | undefined> = []
  const toasts: string[] = []
  const opened: OpenCall[] = []
  const closed: string[] = []
  const registered: string[] = []
  const invalidations: string[] = []
  const sounds: string[] = []
  const openIds = new Set<string>()

  on('state.get', () => ({ value: { value: state, version } }))
  on('state.set', (_$, e) => {
    state = e.value as TimerState
    return { value: { isSet: true, version: ++version } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    if (opts?.openThrows) {
      throw new Error('composer busy / open refused')
    }
    opened.push({
      id: e.id,
      title: e.title,
      focus: e.focus,
      closeOnEscape: e.closeOnEscape,
      holdToasts: e.holdToasts,
      rows: e.rows,
    })
    openIds.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    openIds.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...openIds].map((id) => ({
      id,
      title: id,
      isShown: true,
      isFocused: false,
      isPlaced: true,
    })),
  }))
  on('audio.play', (_$, e) => {
    sounds.push(e.clip.asset ?? '')
    return { value: undefined }
  })
  on('ui.invalidate', (_$, e) => {
    invalidations.push(e.event)
    return { value: undefined }
  })

  return {
    clock,
    state: () => {
      if (!state) throw new Error('no timer state yet')
      return state
    },
    statuses: () => statuses,
    toasts: () => toasts,
    opened: () => opened,
    closed: () => closed,
    registered: () => registered,
    invalidations: () => invalidations,
    sounds: () => sounds,
  }
}

async function startSession($: Engine) {
  await $.session.start({
    surface: 'terminal',
    isInteractive: true,
    cwd: '/work',
  })
}

async function runCmd(
  $: Engine,
  command: string,
  args: string,
) {
  return $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

async function runPomodoro(
  $: Engine,
  args: string,
) {
  return runCmd($, 'pomodoro', args)
}

const mountAbove = {
  plugin: 'pomodoro',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
}

describe('pomodoro', () => {
  test('registers only the pomodoro command', async ($, on) => {
    const w = world(on)
    await startSession($)
    expect(w.registered()).toEqual(['pomodoro'])
    expect(w.registered()).not.toContain('timer')
  })

  test('session.start seeds idle state, always sets idle status chip, and invalidates', async ($, on) => {
    const w = world(on)
    await startSession($)
    expect(w.state().phase).toBe('idle')
    expect(w.state().config.focusMs).toBe(25 * 60_000)
    // Idle must keep a visible chip (clearing status was a Desktop AbovePrompt miss)
    expect(w.statuses().some((s) => s === 'pomodoro · ready')).toBe(true)
    // Immediate invalidate + deferred clock.after(0) pass
    expect(w.invalidations().filter((ev) => ev === 'ui.render').length).toBeGreaterThanOrEqual(1)
    await w.clock.advance(0)
    expect(w.invalidations().filter((ev) => ev === 'ui.render').length).toBeGreaterThanOrEqual(2)
    // Deferred pass re-pins idle status too
    expect(w.statuses().filter((s) => s === 'pomodoro · ready').length).toBeGreaterThanOrEqual(2)
  })

  test('start begins a focus block', async ($, on) => {
    const w = world(on)
    await startSession($)
    const { text } = await runPomodoro($, 'start')
    expect(text).toContain('Focus started')
    const t = w.state()
    expect(t.phase).toBe('focus')
    expect(t.remainingMs).toBe(25 * 60_000)
    expect(t.focusesDone).toBe(0)
    expect(
      w.statuses().some((s) => s?.includes('pomodoro') && s?.includes('focus 1/4')),
    ).toBe(true)
  })

  test('clock advance decreases remaining', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    expect(w.state().remainingMs).toBe(60_000)
    await w.clock.advance(1000)
    expect(w.state().remainingMs).toBe(59_000)
    await w.clock.advance(5000)
    expect(w.state().remainingMs).toBe(54_000)
  })

  test('pause freezes remaining across clock ticks', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    await w.clock.advance(2000)
    expect(w.state().remainingMs).toBe(58_000)
    await runPomodoro($, 'pause')
    expect(w.state().phase).toBe('paused')
    expect(w.state().pausedFrom).toBe('focus')
    await w.clock.advance(10_000)
    expect(w.state().remainingMs).toBe(58_000)
    await runPomodoro($, 'resume')
    expect(w.state().phase).toBe('focus')
    await w.clock.advance(1000)
    expect(w.state().remainingMs).toBe(57_000)
  })

  test('focus complete toasts break and flips band phase', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    await w.clock.advance(60_000)
    const t = w.state()
    expect(t.phase).toBe('break')
    expect(t.remainingMs).toBe(5 * 60_000)
    expect(t.focusesDone).toBe(1)
    expect(
      w
        .toasts()
        .some((msg) => msg === 'Pomodoro break — step away from the keyboard'),
    ).toBe(true)
    expect(w.statuses().some((s) => s?.includes('break'))).toBe(true)
  })

  test('focus→break opens dismissible Pane with focus + closeOnEscape', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    await w.clock.advance(60_000)
    expect(w.state().phase).toBe('break')
    expect(w.opened().length).toBe(1)
    const call = w.opened()[0]!
    expect(call.id).toBe('pomodoro')
    expect(call.focus).toBe(true)
    expect(call.closeOnEscape).toBe(true)
    expect(call.title).toBe('Pomodoro Break')
  })

  test('skip from focus opens break Pane once', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start')
    await runPomodoro($, 'skip')
    expect(w.state().phase).toBe('break')
    expect(w.opened().length).toBe(1)
    expect(w.opened()[0]!.closeOnEscape).toBe(true)
  })

  test('does not reopen Pane if already open on focus→break', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start')
    await runPomodoro($, 'pane')
    expect(w.opened().length).toBe(1)
    await runPomodoro($, 'skip')
    expect(w.state().phase).toBe('break')
    expect(w.opened().length).toBe(1)
  })

  test('break→focus closes break Pane if still open', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    await runPomodoro($, 'skip')
    expect(w.state().phase).toBe('break')
    expect(w.opened().some((p) => p.id === 'pomodoro')).toBe(true)
    await w.clock.advance(5 * 60_000)
    expect(w.state().phase).toBe('focus')
    expect(w.closed().includes('pomodoro')).toBe(true)
  })

  test('openBreakPane failure keeps toast+band (no crash)', async ($, on) => {
    const w = world(on, { openThrows: true })
    await startSession($)
    await runPomodoro($, 'start 1')
    await w.clock.advance(60_000)
    expect(w.state().phase).toBe('break')
    expect(
      w
        .toasts()
        .some((msg) => msg === 'Pomodoro break — step away from the keyboard'),
    ).toBe(true)
    expect(w.statuses().some((s) => s?.includes('break'))).toBe(true)
    expect(w.opened().length).toBe(0)
  })

  test('skip from focus toasts break cue', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start')
    await runPomodoro($, 'skip')
    const t = w.state()
    expect(t.phase).toBe('break')
    expect(t.remainingMs).toBe(5 * 60_000)
    expect(t.focusesDone).toBe(1)
    expect(
      w.toasts().some((msg) => /step away from the keyboard/i.test(msg)),
    ).toBe(true)
  })

  test('break end toasts Back to focus and auto-starts focus', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    await runPomodoro($, 'skip')
    expect(w.state().phase).toBe('break')
    await w.clock.advance(5 * 60_000)
    const t = w.state()
    expect(t.phase).toBe('focus')
    expect(t.remainingMs).toBe(t.config.focusMs)
    expect(w.toasts().some((msg) => msg === 'Back to focus')).toBe(true)
  })

  test('fourth focus skip enters long break with long toast', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'config after 2')
    await runPomodoro($, 'start 1')
    await runPomodoro($, 'skip')
    expect(w.state().phase).toBe('break')
    await runPomodoro($, 'skip')
    expect(w.state().phase).toBe('focus')
    expect(w.closed().includes('pomodoro')).toBe(true)
    await runPomodoro($, 'skip')
    const t = w.state()
    expect(t.phase).toBe('long')
    expect(t.remainingMs).toBe(15 * 60_000)
    expect(
      w
        .toasts()
        .some(
          (msg) => msg === 'Pomodoro long break — step away from the keyboard',
        ),
    ).toBe(true)
    const longOpen = w.opened().filter((p) => p.title === 'Pomodoro Long Break')
    expect(longOpen.length).toBe(1)
    expect(longOpen[0]!.focus).toBe(true)
    expect(longOpen[0]!.closeOnEscape).toBe(true)
  })

  test('AbovePrompt idle shows start duration buttons and config', async ($, on) => {
    world(on)
    await startSession($)
    const ui = await $.ui.mount(mountAbove as any)
    expect(await ui.find({ type: 'Text', text: /Pomodoro/ })).toBeDefined()
    expect(await ui.find({ key: 'band-start-30' })).toBeDefined()
    expect(await ui.find({ key: 'band-start-45' })).toBeDefined()
    expect(await ui.find({ key: 'band-start-60' })).toBeDefined()
    expect(await ui.find({ key: 'band-config' })).toBeDefined()
    // No opaque chassis
    const root = await ui.find({ type: 'Box' })
    const rootProps = (root as { props?: Record<string, unknown> })?.props
    expect(rootProps?.backgroundColor).toBeUndefined()
    expect(rootProps?.borderColor).toBe('promptBorder')
    await ui.unmount()
  })

  test('idle start button begins focus with that many minutes', async ($, on) => {
    const w = world(on)
    await startSession($)
    const ui = await $.ui.mount(mountAbove as any)
    expect(await ui.find({ key: 'band-start-45' })).toBeDefined()
    await ui.press({ key: 'band-start-45' })
    expect(w.state().phase).toBe('focus')
    expect(w.state().remainingMs).toBe(45 * 60_000)
    // Override is for this run only — default config stays 25
    expect(w.state().config.focusMs).toBe(25 * 60_000)
    await ui.unmount()
  })

  test('idle config button opens config pane', async ($, on) => {
    const w = world(on)
    await startSession($)
    const ui = await $.ui.mount(mountAbove as any)
    expect(await ui.find({ key: 'band-config' })).toBeDefined()
    await ui.press({ key: 'band-config' })
    expect(w.opened().some((p) => p.id === 'pomodoro-config')).toBe(true)
    expect(w.opened().some((p) => p.closeOnEscape === true)).toBe(true)
    await ui.unmount()
  })

  test('AbovePrompt shows FOCUS while running', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start')
    const ui = await $.ui.mount(mountAbove as any)
    expect(await ui.find({ type: 'Text', text: /FOCUS 1\/4/ })).toBeDefined()
    expect(await ui.find({ key: 'band-pause' })).toBeDefined()
    expect(await ui.find({ key: 'band-skip' })).toBeDefined()
    expect(await ui.find({ key: 'band-stop' })).toBeDefined()
    await ui.unmount()
    expect(w.state().phase).toBe('focus')
  })

  test('AbovePrompt shows BREAK stretch reminder after skip', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start')
    await runPomodoro($, 'skip')
    const ui = await $.ui.mount(mountAbove as any)
    expect(
      await ui.find({ type: 'Text', text: /BREAK — stretch \/ water/ }),
    ).toBeDefined()
    await ui.unmount()
    expect(w.state().phase).toBe('break')
  })

  test('Pane shows phase controls and break headline', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start')
    await runPomodoro($, 'skip')
    expect(w.opened().some((p) => p.id === 'pomodoro')).toBe(true)

    const ui = await $.ui.mount({
      plugin: 'pomodoro',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'pomodoro',
      props: {
        title: 'Pomodoro Break',
        isFocused: false,
        bodyColumns: 72,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 8 },
        view: {},
      },
    } as any)
    expect(
      await ui.find({
        type: 'Text',
        text: /Pomodoro break — step away from the keyboard/,
      }),
    ).toBeDefined()
    expect(
      await ui.find({ type: 'Text', text: /Remaining .* — Esc or dismiss/ }),
    ).toBeDefined()
    expect(await ui.find({ key: 'pane-pause' })).toBeDefined()
    expect(await ui.find({ key: 'pane-skip' })).toBeDefined()
    expect(await ui.find({ key: 'pane-stop' })).toBeDefined()
    expect(await ui.find({ key: 'pane-dismiss' })).toBeDefined()
    await ui.unmount()
  })

  test('config pane shows chips and saves focus minutes', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'config')
    expect(w.opened().some((p) => p.id === 'pomodoro-config')).toBe(true)

    const ui = await $.ui.mount({
      plugin: 'pomodoro',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'pomodoro-config',
      props: {
        title: 'Pomodoro Config',
        isFocused: true,
        bodyColumns: 72,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 10 },
        view: {},
      },
    } as any)
    expect(
      await ui.find({ type: 'Text', text: /Pomodoro Config/ }),
    ).toBeDefined()
    expect(await ui.find({ key: 'cfg-focus-15' })).toBeDefined()
    expect(await ui.find({ key: 'cfg-focus-25' })).toBeDefined()
    expect(await ui.find({ key: 'cfg-break-5' })).toBeDefined()
    expect(await ui.find({ key: 'cfg-close' })).toBeDefined()
    expect(await ui.find({ key: 'cfg-focus-15' })).toBeDefined()
    await ui.press({ key: 'cfg-focus-15' })
    expect(w.state().config.focusMs).toBe(15 * 60_000)
    await ui.unmount()
  })

  test('config slash updates break minutes', async ($, on) => {
    const w = world(on)
    await startSession($)
    const { text } = await runPomodoro($, 'config break 3')
    expect(text).toContain('Config saved')
    expect(w.state().config.breakMs).toBe(3 * 60_000)
    await runPomodoro($, 'start 1')
    await runPomodoro($, 'skip')
    expect(w.state().phase).toBe('break')
    expect(w.state().remainingMs).toBe(3 * 60_000)
  })

  test('stop returns to idle and restores idle status chip', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start')
    await runPomodoro($, 'stop')
    expect(w.state().phase).toBe('idle')
    expect(w.statuses().at(-1)).toBe('pomodoro · ready')
  })

  test('AbovePrompt strip has no opaque backgroundColor while running', async ($, on) => {
    world(on)
    await startSession($)
    await runPomodoro($, 'start')
    const ui = await $.ui.mount(mountAbove as any)
    const root = await ui.find({ type: 'Box' })
    expect(root).toBeDefined()
    const rootProps = (root as { props?: Record<string, unknown> })?.props
    expect(rootProps?.backgroundColor).toBeUndefined()
    expect(rootProps?.borderColor).toBe('#f59e0b')
    expect(rootProps?.borderStyle).toBe('round')
    const time = await ui.find({ type: 'Text', text: /\d+:\d+/ })
    expect(time).toBeDefined()
    const timeProps = (time as { props?: Record<string, unknown> })?.props
    expect(timeProps?.color).toBe('text')
    await ui.unmount()
  })

  test('Pane has no opaque backgroundColor', async ($, on) => {
    world(on)
    await startSession($)
    await runPomodoro($, 'start')
    const ui = await $.ui.mount({
      plugin: 'pomodoro',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'pomodoro',
      props: {
        title: 'Pomodoro',
        isFocused: false,
        bodyColumns: 72,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 8 },
        view: {},
      },
    } as any)
    const root = await ui.find({ type: 'Box' })
    expect(root).toBeDefined()
    const rootProps = (root as { props?: Record<string, unknown> })?.props
    expect(rootProps?.backgroundColor).toBeUndefined()
    expect(rootProps?.borderColor).toBe('#f59e0b')
    await ui.unmount()
  })

  test('hybrid theme tokens: no strip chassis, hex phase accents', async () => {
    expect((__tokens.THEME as Record<string, string>).chassis).toBeUndefined()
    expect(__tokens.THEME.border).toBe('promptBorder')
    expect(__tokens.THEME.inactive).toBe('inactive')
    expect(__tokens.THEME.subtle).toBe('subtle')
    expect(__tokens.THEME.text).toBe('text')
    expect(__tokens.COLORS.focus).toBe('#f59e0b')
    expect(__tokens.COLORS.break).toBe('#2dd4bf')
    expect(__tokens.COLORS.long).toBe('#c084fc')
    expect(__tokens.COLORS.urgency).toMatch(/^#/)
    expect(__tokens.PANE_ID).toBe('pomodoro')
    expect(__tokens.CONFIG_PANE_ID).toBe('pomodoro-config')
    expect([...__tokens.IDLE_START_MINUTES]).toEqual([30, 45, 60])
  })

  test('config.set theme invalidates ui.render', async ($, on) => {
    const w = world(on)
    on('config.set', { key: 'theme' }, (_$, e) => ({ value: e.value }))
    await startSession($)
    const before = w.invalidations().filter((ev) => ev === 'ui.render').length
    await $.config.set({
      key: 'theme',
      value: 'dark',
      previous: 'light',
      provider: { plugin: 'engine', tier: 'core' },
    } as Parameters<Engine['config']['set']>[0])
    const after = w.invalidations().filter((ev) => ev === 'ui.render').length
    expect(after).toBeGreaterThan(before)
  })

  test('stop during a break closes the break Pane', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    await runPomodoro($, 'skip')
    expect(w.opened().some((p) => p.id === 'pomodoro')).toBe(true)
    await runPomodoro($, 'stop')
    expect(w.closed()).toContain('pomodoro')
  })

  test('skip reports the phase it moved to', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    const { text } = await runPomodoro($, 'skip')
    expect(text).toBe('Skipped → BREAK 5:00')
    expect(w.state().phase).toBe('break')
  })

  test('remaining time follows the clock across a long gap', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 10')
    await w.clock.advance(4 * 60_000 + 30_000)
    expect(w.state().remainingMs).toBe(5 * 60_000 + 30_000)
    expect(w.state().endsAt).toBe(1_000_000 + 10 * 60_000)
  })

  test('band pause then resume acts on the latest state', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    const ui = await $.ui.mount(mountAbove as any)
    await ui.press({ key: 'band-pause' })
    expect(w.state().phase).toBe('paused')
    expect(w.state().endsAt).toBeNull()
    await ui.press({ key: 'band-pause' })
    expect(w.state().phase).toBe('focus')
    await ui.unmount()
  })

  test('rejects out-of-range lengths', async ($, on) => {
    const w = world(on)
    await startSession($)
    expect((await runPomodoro($, 'start 1e308')).text).toBe(
      'usage: /pomodoro start [minutes]',
    )
    expect((await runPomodoro($, 'config focus 601')).text).toMatch(/between/)
    expect((await runPomodoro($, 'config after 13')).text).toMatch(/1 to 12/)
    expect((await runPomodoro($, 'config after 2.5')).text).toMatch(/whole number/)
    expect(w.state().config.focusMs).toBe(25 * 60_000)
    expect(w.state().config.longAfter).toBe(4)
  })

  test('saved config is restored by the next session', async ($, on) => {
    const base = { focusMs: 25 * 60_000, breakMs: 5 * 60_000, longBreakMs: 15 * 60_000, longAfter: 4 }
    const w = world(on, {
      store: { config: { config: { ...base, focusMs: 50 * 60_000 }, base } },
    })
    await startSession($)
    expect(w.state().config.focusMs).toBe(50 * 60_000)
  })

  test('changed plugin settings win over a saved config', async ($, on) => {
    const base = { focusMs: 20 * 60_000, breakMs: 5 * 60_000, longBreakMs: 15 * 60_000, longAfter: 4 }
    const w = world(on, {
      store: { config: { config: { ...base, focusMs: 50 * 60_000 }, base } },
    })
    await startSession($)
    expect(w.state().config.focusMs).toBe(25 * 60_000)
  })

  test('config changes are saved and reset clears them', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'config focus 40')
    await runPomodoro($, 'stop')
    // A new session start reads the saved config back from the store.
    await startSession($)
    expect(w.state().config.focusMs).toBe(40 * 60_000)
    const { text } = await runPomodoro($, 'config reset')
    expect(text).toMatch(/^Config reset/)
    expect(w.state().config.focusMs).toBe(25 * 60_000)
    await startSession($)
    expect(w.state().config.focusMs).toBe(25 * 60_000)
  })

  test('a block running out plays its chime', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    await w.clock.advance(60_000)
    expect(w.sounds()).toEqual(['sounds/break.wav'])
    await w.clock.advance(5 * 60_000)
    expect(w.sounds()).toEqual(['sounds/break.wav', 'sounds/focus.wav'])
  })

  test('skip and stop play no chime', async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    await runPomodoro($, 'skip')
    await runPomodoro($, 'skip')
    await runPomodoro($, 'stop')
    expect(w.sounds()).toEqual([])
  })

  test('the sound setting turns chimes off', { options: { sound: false } }, async ($, on) => {
    const w = world(on)
    await startSession($)
    await runPomodoro($, 'start 1')
    await w.clock.advance(60_000)
    expect(w.state().phase).toBe('break')
    expect(w.sounds()).toEqual([])
  })
})
