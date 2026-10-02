# Pomodoro for Claude Code

A button-first Pomodoro timer that lives above the Claude Code prompt: start a
focus block with one click, watch the countdown while you work, and get a
nudge to step away from the keyboard when it is time for a break.

```text
● Pomodoro · 1: ▶ 30  2: ▶ 45  3: ▶ 60  c: ⚙
● FOCUS 1/4   24:59   ████████   1: pause  2: skip  3: stop
◐ BREAK — stretch / water   4:59   ███░░░░░   1: pause  2: skip  3: stop
```

Works in the Claude Code terminal and in the Code tab of the Claude desktop
app. It follows the host's light, dark and auto themes.

## Requirements

Claude Code 2.1.286 or later. The plugin is a hooks module, so older versions
do not load it.

## Install

From this repository, which is also a plugin marketplace:

```bash
claude plugin marketplace add sneycampos/claude-pomodoro
claude plugin install pomodoro@claude-pomodoro
```

Or inside a session: `/plugin marketplace add sneycampos/claude-pomodoro`,
then `/plugin install pomodoro@claude-pomodoro`.

From a local checkout, for one session:

```bash
claude --plugin-dir /path/to/claude-pomodoro
```

In the desktop app you can also upload the release zip from the plugins
screen.

## Using it

### Idle band

Shown above the prompt once a session starts. In the desktop app, a brand-new
session starts when you send its first message, so the band appears after
that. To start a timer with that first message, send `/pomodoro start 30`.

- **▶ 30 / ▶ 45 / ▶ 60** start a focus block of that many minutes. The length
  applies to this block only; later focus blocks use your configured length.
- **⚙** opens the config Pane.
- Hotkeys: `1`, `2`, `3` for the durations, `c` for config.

### Running band

Shows the phase, the time left and a progress bar, with **pause / resume**,
**skip** and **stop** (hotkeys `1`, `2`, `3`). The band turns red in the last
minute. While Claude Code shows a survey above the prompt, the band steps
aside.

### Breaks

When a focus block ends:

1. A chime plays and a toast says `Pomodoro break — step away from the
   keyboard`.
2. A break Pane opens with the countdown and controls. `Esc` or **dismiss**
   (`d`) closes the Pane only; the break keeps running.
3. The band and the status line switch to the break colors.

After `longAfter` focus blocks (4 by default) the break is a long break. When
a break ends, a rising chime plays, the Pane closes, a toast says
`Back to focus`, and the next focus block starts on its own. Chimes play only
when a block runs out, not when you skip or stop it. Skipping a focus block counts toward the long break,
the same as finishing it.

### Config Pane

Opened from **⚙** or `/pomodoro config`. Chip rows set the focus, break and
long-break lengths and how many focus blocks come before a long break; **−**
and **+** step the focus length by one minute. Changes apply at once and are
saved for future sessions.

## Commands

`/pomodoro` is registered when the session starts. The desktop app's
autocomplete may not list it, but it runs when typed in full.

```text
/pomodoro                          status
/pomodoro start [minutes]          start a focus block (default: configured length)
/pomodoro pause
/pomodoro resume
/pomodoro skip                     end the current phase early
/pomodoro stop
/pomodoro config                   open the config Pane
/pomodoro config focus 25          set one or more of focus|break|long|after
/pomodoro config break=5 long=15
/pomodoro config reset             go back to the plugin settings
/pomodoro pane                     open the timer Pane
/pomodoro pane close
```

Lengths are minutes, from 1 second (`0.0167`) to 600; `after` is a whole number
from 1 to 12.

## Settings

The defaults come from the plugin's settings, which you can change on the
plugin's settings screen:

| Setting                   | Default |
| ------------------------- | ------- |
| Focus minutes             | 25      |
| Break minutes             | 5       |
| Long break minutes        | 15      |
| Focuses before long break | 4       |
| Play a sound              | on      |

A change made in the config Pane or with `/pomodoro config` is saved and wins
over these settings until you change the settings themselves or run
`/pomodoro config reset`.

## How it works

- The timer is kept in the session's plugin state, so it survives a reload of
  the plugin. The countdown is computed from the block's end time, so a late
  tick or a sleeping laptop does not make it drift.
- Every change to the timer goes through one conflict-checked update, so a
  button press and a clock tick at the same moment cannot undo each other.
- Chimes play through the platform's audio player (`afplay` on macOS); where
  there is none, the timer works silently.
- Saved config lives in the plugin's own store under your Claude Code
  configuration directory.

## Development

```bash
claude plugin validate .
claude plugin test .
```

To type-check: Claude Code writes its API types to `.claude-plugin/types/` when
it loads the plugin from a local folder (`claude --plugin-dir .`). Then:

```bash
npx -p typescript@5 tsc -p .
```

Layout:

```text
.claude-plugin/plugin.json        manifest and settings
.claude-plugin/marketplace.json   lets this repository act as a marketplace
hooks/hooks.json                  points at the hooks module
hooks/pomodoro.ts                 the plugin
types/index.d.ts                  the plugin's state contract
sounds/                           the break and focus chimes
tests/pomodoro.test.ts            tests run by `claude plugin test`
```

## License

[MIT](LICENSE)
