# TODO

- [ ] Manually verify two Pi instances in different Kitty tabs focus the sender, not the most recent instance.
- [ ] Manually verify two Pi instances in different tmux panes select the originating pane after activation.
- [ ] Manually verify short runs, brief focus changes, aborted runs, retries, queued follow-ups, watched completions, delayed-away completions, and qualifying unattended runs.
- [ ] Pursue the standards-compliant Quickshell/DMS activation-token fix upstream:
  - [ ] Have DMS obtain a valid XDG activation token from the notification click and pass it to the action invocation.
  - [ ] Have Quickshell expose `NotificationAction.invoke(token)` and emit `ActivationToken` immediately before `ActionInvoked`, as proposed in Quickshell PR #931.
  - [ ] Remove or retain the niri IPC path only as a fallback once upstream activation reliably focuses the originating OS window and workspace.
