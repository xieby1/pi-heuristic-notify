# pi-heuristic-notify

> **Development moved into my personal Nix configuration.**
> The maintained source, tests, and Home Manager module live in
> [xieby1/nix_config](https://github.com/xieby1/nix_config), under
> `usr/cli/basic/pi/extensions/heuristic-notify/`.
> This repository is retained for its history and existing pinned revisions;
> the documentation below describes the standalone version.

Pi extension that sends completion notifications only after Pi fully settles and both conditions hold:

```text
run duration >= minimum run duration
and continuous terminal unfocused duration >= minimum away duration
```

It also sends a `Pi needs your input` notification while `rpiv-ask-user-question` is waiting for an answer, if the terminal has been continuously unfocused for the minimum away duration. This actionable exception does **not** require a minimum run duration or wait for `agent_settled`. Questions seen while focused stay silent; pending alerts are cancelled when answered, refocused, or shut down. The alert uses RPIV's existing `rpiv:ask-user:blocked` event and the same exact-origin activation as completion alerts. RPIV emits `blocked: true` before loading the dialog, so an alert can occasionally precede the UI or fire if loading stalls; answering or closing the question cancels a pending alert. No RPIV patch is required. Without `rpiv-ask-user-question`, this feature has no effect and adds no npm runtime dependency.

A final settled run can notify whether it completed successfully or failed; failed runs use the title `Pi run failed`. Intermediate tool or agent errors do not notify while Pi can retry or continue. When `pi-retry` is installed, its `pi-retry:started`, `pi-retry:completed`, and `pi-retry:cancelled` events suppress failed attempts during detached retries; only a recovered completion or a final failure after retries are exhausted can notify. Escape or new input cancels the pending alert. No `pi-retry` dependency or configuration is required. A run settled while focused is suppressed permanently; leaving the terminal afterward does not notify for that run. Unknown focus, short runs, aborted or interrupted runs, retries, queued follow-ups, and brief focus changes are also suppressed.

## Why This Extension

Existing Pi notification extensions cover parts of this workflow, but not the complete heuristic:

| Extension | Settled lifecycle | Minimum run time | Minimum continuous away time | Exact-origin activation |
| --- | --- | --- | --- | --- |
| [`pi-ping`](https://github.com/Bukutsu/pi-ping) | Yes | Fixed work gate using duration, tools, or errors | No; checks focus only at completion | Partial |
| [`desktop-notify-kitty`](https://github.com/cjrh/desktop-notify-kitty) | No; uses `agent_end` | No | No | Kitty-focused |
| `pi-heuristic-notify` | Yes, using `agent_settled` | Configurable | Configurable and continuous | Originating Ghostty surface, where notification activation is supported |

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
  "showPrompt": true,
  "notifyOnQuestion": true
}
```

Every property is optional; omitted properties use the values shown above. Durations may be zero or fractional, but must be finite and non-negative. `urgency` must be `low`, `normal`, or `critical`; `showPrompt` and `notifyOnQuestion` must be booleans. Set `notifyOnQuestion` to `false` to disable question alerts. When `showPrompt` is `false`, question and prompt text are both hidden; otherwise the alert shows the first question, last user prompt, and elapsed run duration. `urgency` and `expirySeconds` apply to the Linux `notify-send` fallback; Ghostty's OSC 777 notification protocol does not accept them.

Pi's `PI_CODING_AGENT_DIR` relocates the file with the rest of the agent configuration. A missing file uses defaults. Invalid JSON or values report an error and disable automatic and test notifications for that session. Run `/reload` after editing the file.

CLI flags, project-local overrides, live file watching, and automatic config generation are not supported. To disable the extension entirely, remove it from Pi or do not load it.

## Commands

- `/notify-check` reports the resolved configuration path, effective values, focus and away time, run duration, pending delivery, backend, and suppression reason.
- `/notify-test` sends an immediate test through the selected backend without applying heuristic thresholds.

Command and delivery failures are reported in Pi without crashing the session.

## Requirements

- Node.js 22.19 or newer.
- Pi 0.82.1 (tested).
- Ghostty with OSC 777 notifications for native activation of the originating surface.
- Linux `notify-send` for fallback delivery outside Ghostty or when writing to the terminal fails.

The extension has zero npm runtime, peer, and optional dependencies. Its deployed source uses Node built-ins and Pi's host-provided extension API.

## Backends And Limits

Inside Ghostty, the extension writes an OSC 777 notification to the originating terminal surface; clicking the native notification requests that Ghostty present that surface (window/tab/split). Whether the window is actually raised also depends on the notification server and compositor activation policy, including whether Ghostty receives a usable XDG activation token on Wayland. Ghostty may silently rate-limit alerts (one per second across the app, or repeat content within five seconds) and replace an earlier alert with the same body; this extension does not patch Ghostty or the notification server. `/notify-test` confirms the sequence was written, not that an alert appeared or was activated.

On niri 26.04 with Ghostty 1.3.1 and DMS 1.4.6, clicking did not focus Ghostty under niri's default serial check, even when patched Quickshell emitted `ActivationToken` before `ActionInvoked`. In a live test, niri's `honor-xdg-activation-with-invalid-serial` debug setting returned to the originating Ghostty window and Pi tab even with unpatched Quickshell. This niri-wide workaround is not an extension requirement: it weakens focus-stealing protection for all apps. Remove it when exact-tab focus works with the setting disabled, or replace it with a Ghostty-only activation rule when supported by niri.

On Linux, failed or unavailable Ghostty delivery falls back to `notify-send`. Generic notification servers cannot guarantee that clicking returns to the originating terminal. Commands receive notification content as argument arrays, never shell command strings.

The extension targets Ghostty and Linux. It does not implement done-tab markers, broad cross-platform backends, or terminal visibility detection.
