# pi-heuristic-notify

## Requirements

Build a customizable Pi desktop-notification extension with these behaviors:

- Notify only after Pi fully settles and both configurable heuristic thresholds hold:

  ```text
  run duration >= minimum run duration
  and continuous terminal unfocused duration >= minimum away duration
  ```

- Allow users to customize the heuristic thresholds and notification behavior.
- The deployed extension must have zero npm runtime dependencies; development and test dependencies are allowed.
- Clicking a notification must focus the exact Pi instance that sent it, including the originating terminal window, tab, or pane where supported.
- Show the last user prompt and last run duration in the notification.
- Avoid notifications for short tasks, brief focus changes, intermediate retries, queued follow-ups, and runs completed while the user is watching the terminal.

## References

### Closest Reference

#### [Bukutsu/pi-ping](https://github.com/Bukutsu/pi-ping)

The closest existing implementation:

- tracks focus with DECSET 1004 and `ctx.ui.onTerminalInput()`;
- uses `agent_settled`, avoiding intermediate retries and queued follow-ups;
- suppresses aborted and trivial turns;
- sends Kitty OSC 99, OSC 9/777, or Linux `notify-send` notifications;
- includes a tmux focus fallback and a `/notify-check` diagnostic command;
- marks an unfocused completed terminal tab as done.

Its work gate is `duration >= 10s OR tool calls OR errors`. It checks current focus at completion, but does not require the terminal to have remained unfocused for a configurable duration.

### Other References

#### [cjrh/desktop-notify-kitty](https://github.com/cjrh/desktop-notify-kitty)

Strong fit for the current Kitty/Linux environment. Uses Kitty remote control plus DECSET 1004 focus tracking, `kitten notify` for click-to-focus, and `notify-send` as fallback. Missing run-duration and unfocused-duration thresholds; hooks `agent_end`.

### Conclusion

No surveyed public extension implements both minimum run duration and minimum continuous unfocused duration. `pi-ping` provides the best lifecycle and focus-tracking reference; `desktop-notify-kitty` provides the best Kitty-specific focus and delivery reference.
