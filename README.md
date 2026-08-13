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
