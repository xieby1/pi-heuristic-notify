# pi-heuristic-notify

Pi extension that notifies after a sufficiently long run while its terminal has remained unfocused.

## Configuration

Pass options when starting Pi:

```text
--notify-minimum-run-seconds <seconds>   Minimum run duration (default: 10)
--notify-minimum-away-seconds <seconds>  Minimum continuous unfocused time (default: 5)
--notify-urgency <level>                  low, normal, or critical (default: normal)
--notify-expiry-seconds <seconds>         Notification lifetime (default: 10)
--notify-hide-prompt                      Omit the last prompt (default: false)
```

Durations may be zero or fractional, but must be finite and non-negative. Invalid configuration reports an error and disables notifications for the session.

To disable the extension entirely, start Pi without loading it or remove it from Pi's configured extensions. There is no separate enable flag.

## Notification Delivery

Inside Kitty, the extension uses `kitten notify` with a unique identifier for each Pi session. Activating the notification focuses the originating Kitty window and tab. When Pi runs inside tmux, the extension also captures `TMUX_PANE` and selects that pane only after Kitty reports notification activation.

On Linux, a failed or unavailable Kitty notification falls back to `notify-send`. Generic desktop notification servers cannot guarantee that clicking this fallback returns to the originating terminal. Delivery errors are shown in Pi but do not fail or delay settlement.

Kitty, `notify-send`, and tmux commands receive notification content as argument arrays; no shell command string is constructed.

## Diagnostics

Use `/notify-check` to inspect the active configuration, terminal focus and away duration, last run duration, pending delivery, selected backend, and current suppression reason.

Use `/notify-test` to send an immediate test through the selected backend. The command reports success or the backend error in Pi without applying the run or away thresholds.

## Terminal Focus

The extension uses DECSET 1004 focus events to measure continuous time away. Until the terminal reports an authoritative `FocusOut`, focus is unknown and automatic notifications are suppressed.

When running inside tmux, enable focus event forwarding:

```tmux
set -g focus-events on
```
