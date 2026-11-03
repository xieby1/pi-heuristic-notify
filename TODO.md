# TODO

- [ ] Manually verify two Pi instances in different Ghostty tabs activate the sender, not the most recently focused tab.
- [ ] Manually verify short runs, brief focus changes, aborted runs, retries, queued follow-ups, watched completions, delayed-away completions, and qualifying unattended runs.
- [ ] Diagnose why Ghostty does not focus under niri's default serial check even when Quickshell emits `ActivationToken` before `ActionInvoked`; distinguish an unusable token from Ghostty not consuming it.
- [ ] After the upstream activation path changes, re-test notifications across workspaces and Ghostty tabs with niri's invalid-serial workaround disabled before removing it from the documentation.
