# pi-heuristic-notify

> **Development moved into my personal Nix configuration.**
> The maintained source, tests, and Home Manager module live in
> [xieby1/nix_config](https://github.com/xieby1/nix_config), under
> `usr/cli/basic/pi/extensions/heuristic-notify/`.
> This repository is retained for its history and existing pinned revisions;
> the documentation below describes the standalone version.

Pi extension that sends a desktop notification only after Pi fully settles and both conditions hold:

```text
run duration >= minimum run duration
and continuous terminal unfocused duration >= minimum away duration
```

A final settled run can notify whether it completed successfully or failed; failed runs use the title `Pi run failed`. Intermediate tool or agent errors do not notify while Pi can retry or continue. A run settled while focused is suppressed permanently; leaving the terminal afterward does not notify for that run. Unknown focus, short runs, aborted or interrupted runs, retries, queued follow-ups, and brief focus changes are also suppressed.

## Why This Extension

Existing Pi notification extensions cover parts of this workflow, but not the complete heuristic:

| Extension | Settled lifecycle | Minimum run time | Minimum continuous away time | Exact-origin activation |
| --- | --- | --- | --- | --- |
| [`pi-ping`](https://github.com/Bukutsu/pi-ping) | Yes | Fixed work gate using duration, tools, or errors | No; checks focus only at completion | Partial Kitty/tmux support |
| [`desktop-notify-kitty`](https://github.com/cjrh/desktop-notify-kitty) | No; uses `agent_end` | No | No | Kitty-focused |
| `pi-heuristic-notify` | Yes, using `agent_settled` | Configurable | Configurable and continuous | Originating niri window, Kitty tab/window, and tmux pane where available |

This extension was created to avoid notifications that are technically correct but not useful: short work, momentary focus changes, intermediate retries, queued continuations, and completions that the user already watched. Requiring both sustained work and sustained absence makes a notification mean that Pi finished something worth returning to. Exact-origin activation then returns the user to the Pi instance that sent it rather than whichever terminal was used most recently.

## Install

Install from npm after publication:

```bash
pi install npm:pi-heuristic-notify
```

For local development or evaluation:

```bash
pi install /absolute/path/to/pi-heuristic-notify
```

Restart Pi after installation, or run `/reload` in an existing session.

## Configuration

Create `~/.pi/agent/pi-heuristic-notify.json`:

```json
{
  "minimumRunSeconds": 10,
  "minimumAwaySeconds": 5,
  "urgency": "normal",
  "expirySeconds": 10,
  "showPrompt": true
}
```

Every property is optional; omitted properties use the values shown above. Durations may be zero or fractional, but must be finite and non-negative. `urgency` must be `low`, `normal`, or `critical`, and `showPrompt` must be a boolean.

Pi's `PI_CODING_AGENT_DIR` relocates the file with the rest of the agent configuration. A missing file uses defaults. Invalid JSON or values report an error and disable automatic and test notifications for that session. Run `/reload` after editing the file.

CLI flags, project-local overrides, live file watching, and automatic config generation are not supported. To disable the extension entirely, remove it from Pi or do not load it.

## Commands

- `/notify-check` reports the resolved configuration path, effective values, focus and away time, run duration, pending delivery, backend, and suppression reason.
- `/notify-test` sends an immediate test through the selected backend without applying heuristic thresholds. Under niri it watches the notification daemon's action asynchronously and exercises the same niri/Kitty/tmux origin restoration as automatic notifications.

Command and delivery failures are reported in Pi without crashing the session.

## Requirements

- Node.js 22.19 or newer.
- Pi 0.82.1 (tested).
- Kitty 0.36 or newer for notification activation that focuses the originating Kitty window and tab.
- niri IPC for optional exact OS-window and workspace restoration under niri.
- Linux `notify-send` for fallback delivery outside Kitty or when Kitty delivery fails.
- tmux `focus-events` when running inside tmux:

```tmux
set -g focus-events on
```

The extension has zero npm runtime, peer, and optional dependencies. Its deployed source uses Node built-ins and Pi's host-provided extension API.

## Backends And Limits

Inside Kitty, `kitten notify` uses a unique identifier per Pi session. Activating it focuses the originating Kitty window and tab; inside tmux, the captured `TMUX_PANE` is selected only after activation. Under niri, the extension validates the focused Kitty toplevel against `KITTY_PID`, captures its niri window ID without polling, and uses `notify-send --action` to observe the click directly. It then focuses the captured niri window, Kitty tab, and tmux pane in order. Capture and focus failures are non-fatal. Outstanding activation watchers are aborted on session shutdown.

On Linux, failed or unavailable Kitty delivery falls back to `notify-send`. Generic notification servers cannot guarantee that clicking returns to the originating terminal. Commands receive notification content as argument arrays, never shell command strings.

The initial release targets Kitty and Linux. It does not implement done-tab markers, broad cross-platform backends, or terminal visibility detection.
