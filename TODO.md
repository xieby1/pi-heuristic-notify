# TODO

## Distinguish Failed Settled Runs

- [x] Classify the final settled run outcome.
  - [x] Add a failing lifecycle test that a final assistant `stopReason: "error"` becomes eligible only after `agent_settled` when both existing heuristic thresholds hold.
  - [x] Add a failing lifecycle test that an intermediate `agent_end` error followed by a final successful `agent_end` produces one successful outcome, not a failed outcome or an early notification.
  - [x] Add a failing lifecycle test that aborted and interrupted runs remain suppressed.
  - [x] Add the smallest outcome field to `EligibleRun` and derive it from the final assistant stop reason; do not listen for individual tool failures.

- [ ] Present failed runs distinctly.
  - [ ] Add failing content tests that completed runs use `Pi run complete` and failed runs use `Pi run failed`.
  - [ ] Keep prompt, duration, urgency, expiry, and `showPrompt` behavior identical for both outcomes.
  - [ ] Pass the classified outcome through automatic delivery without adding a configuration option or separate delivery path.

- [ ] Document and verify failed-run notifications.
  - [ ] Document that only final settled failures are eligible; intermediate tool/agent errors, retries, aborts, and interrupted runs do not notify as failures.
  - [ ] Run `npm test`, strict typechecking, and the real-loader smoke test.
  - [ ] Run the Nix-shell test/typecheck/loader-smoke suite.
  - [ ] Run `npm pack --dry-run --json` and `npm ls --omit=dev --all --json` to preserve the three-file package and zero npm runtime dependencies.
  - [ ] Manually verify one qualifying unattended failed run and one watched or below-threshold failed run.

- [ ] Manually verify two Pi instances in different Kitty tabs focus the sender, not the most recent instance.
- [ ] Manually verify two Pi instances in different tmux panes select the originating pane after activation.
- [ ] Manually verify short runs, brief focus changes, aborted runs, retries, queued follow-ups, watched completions, delayed-away completions, and qualifying unattended runs.
- [ ] Pursue the standards-compliant Quickshell/DMS activation-token fix upstream:
  - [ ] Have DMS obtain a valid XDG activation token from the notification click and pass it to the action invocation.
  - [ ] Have Quickshell expose `NotificationAction.invoke(token)` and emit `ActivationToken` immediately before `ActionInvoked`, as proposed in Quickshell PR #931.
  - [ ] Remove or retain the niri IPC path only as a fallback once upstream activation reliably focuses the originating OS window and workspace.
