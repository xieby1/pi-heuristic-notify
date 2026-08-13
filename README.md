# pi-heuristic-notify

Pi extension that sends a desktop notification only after Pi fully settles and both conditions hold:

```text
run duration >= minimum run duration
and continuous terminal unfocused duration >= minimum away duration
```

A run completed while focused is suppressed permanently; leaving the terminal afterward does not notify for that run. Unknown focus, short runs, aborted or interrupted runs, retries, queued follow-ups, and brief focus changes are also suppressed.

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

Pass options when starting Pi:

```text
--notify-minimum-run-seconds <seconds>   Minimum run duration (default: 10)
--notify-minimum-away-seconds <seconds>  Minimum continuous unfocused time (default: 5)
--notify-urgency <level>                  low, normal, or critical (default: normal)
--notify-expiry-seconds <seconds>         Notification lifetime (default: 10)
--notify-hide-prompt                      Omit the last prompt (default: false)
```

Durations may be zero or fractional, but must be finite and non-negative. Invalid configuration reports an error and disables notifications for the session. To disable the extension entirely, remove it from Pi or do not load it.

## Commands

- `/notify-check` reports configuration, focus and away time, run duration, pending delivery, backend, and suppression reason.
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

The extension has zero npm runtime, peer, and optional dependencies. Its deployed source imports only Node built-ins; the Pi API import is type-only and erased at runtime.

## Backends And Limits

Inside Kitty, `kitten notify` uses a unique identifier per Pi session. Activating it focuses the originating Kitty window and tab; inside tmux, the captured `TMUX_PANE` is selected only after activation. Under niri, the extension validates the focused Kitty toplevel against `KITTY_PID`, captures its niri window ID without polling, and uses `notify-send --action` to observe the click directly. It then focuses the captured niri window, Kitty tab, and tmux pane in order. Capture and focus failures are non-fatal. Outstanding activation watchers are aborted on session shutdown.

On Linux, failed or unavailable Kitty delivery falls back to `notify-send`. Generic notification servers cannot guarantee that clicking returns to the originating terminal. Commands receive notification content as argument arrays, never shell command strings.

The initial release targets Kitty and Linux. It does not implement done-tab markers, broad cross-platform backends, or terminal visibility detection.
