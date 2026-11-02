# TODO

- [ ] Manually verify two Pi instances in different Ghostty tabs activate the sender, not the most recently focused tab.
- [ ] Manually verify short runs, brief focus changes, aborted runs, retries, queued follow-ups, watched completions, delayed-away completions, and qualifying unattended runs.
- [ ] Pursue the standards-compliant Quickshell/DMS activation-token fix upstream:
  - [ ] Have DMS obtain a valid XDG activation token from the notification click and pass it to the action invocation.
  - [ ] Have Quickshell expose `NotificationAction.invoke(token)` and emit `ActivationToken` immediately before `ActionInvoked`, as proposed in Quickshell PR #931.
  - [ ] Retest Ghostty OSC 777 activation under niri after the daemon forwards activation tokens.
