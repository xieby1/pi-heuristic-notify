# TODO

## Replace CLI Flags With Global JSON Configuration

- [x] Define the JSON configuration contract and validation.
  - [x] Add failing tests that an empty object and partial objects merge over `DEFAULT_CONFIG`.
  - [x] Add failing tests for `minimumRunSeconds`, `minimumAwaySeconds`, and `expirySeconds` at zero, fractional values, negative values, non-finite values, and wrong types.
  - [x] Add failing tests that `urgency` accepts only `low`, `normal`, or `critical`, and `showPrompt` accepts only booleans.
  - [x] Rename the parsed properties to `minimumRunSeconds`, `minimumAwaySeconds`, `expirySeconds`, `urgency`, and positive `showPrompt`; keep milliseconds internal after validation.

- [x] Load `pi-heuristic-notify.json` from Pi's global agent directory.
  - [x] Add failing tests that the path is `join(getAgentDir(), "pi-heuristic-notify.json")`, including a custom `PI_CODING_AGENT_DIR` through the injected path in tests.
  - [x] Add failing tests that a missing file uses `DEFAULT_CONFIG` without warning.
  - [x] Add failing tests that valid JSON loads partial overrides and ignores no specified defaults.
  - [x] Add failing tests that malformed JSON, a non-object JSON root, and invalid property values return a useful error containing the config path.
  - [x] Implement one read on session startup with Node's built-in JSON and filesystem APIs; add no dependency, file watcher, or generated config file.

- [x] Make the config file the sole configuration source.
  - [x] Add a failing factory test that `session_start` loads the file once and applies its values to `/notify-check` and notification content.
  - [x] Add a failing factory test that invalid configuration visibly disables automatic delivery and `/notify-test` for the session.
  - [x] Add a failing reload test that a new `session_start` re-reads changed configuration.
  - [x] Remove `FLAG_NAMES`, all `registerFlag()` calls, `getFlag()` reads, and command-option parsing.
  - [x] Remove obsolete flag support from the fake `ExtensionAPI` harness if no other test uses it.

- [ ] Update user-facing configuration documentation.
  - [ ] Replace the CLI option section with the path `~/.pi/agent/pi-heuristic-notify.json`, its JSON shape, defaults, partial override behavior, and `/reload` instructions.
  - [ ] Document that `PI_CODING_AGENT_DIR` relocates the file, a missing file uses defaults, and invalid configuration disables notifications for the session.
  - [ ] Document that CLI flags, project-local overrides, live file watching, and automatic config generation are unsupported.
  - [ ] Update `/notify-check` to report the resolved config path along with the effective values and add a diagnostics assertion for it.

- [ ] Verify the configuration migration.
  - [ ] Run `npm test`, strict typechecking, and the real-loader smoke test.
  - [ ] Run the Nix-shell test/typecheck/loader-smoke suite.
  - [ ] Run `npm pack --dry-run` and verify the package still contains only the intended deployed files.
  - [ ] Run `npm ls --omit=dev --all --json` and verify zero runtime dependencies.
  - [ ] Manually test absent, valid, and invalid global config files, using `/reload` and `/notify-check` after each change.

## Remaining Release Work
- [ ] Manually verify two Pi instances in different Kitty tabs focus the sender, not the most recent instance.
- [ ] Manually verify two Pi instances in different tmux panes select the originating pane after activation.
- [ ] Manually verify short runs, brief focus changes, aborted runs, retries, queued follow-ups, watched completions, delayed-away completions, and qualifying unattended runs.
- [ ] Pursue the standards-compliant Quickshell/DMS activation-token fix upstream:
  - [ ] Have DMS obtain a valid XDG activation token from the notification click and pass it to the action invocation.
  - [ ] Have Quickshell expose `NotificationAction.invoke(token)` and emit `ActivationToken` immediately before `ActionInvoked`, as proposed in Quickshell PR #931.
  - [ ] Remove or retain the niri IPC path only as a fallback once upstream activation reliably focuses the originating OS window and workspace.
