import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FLAG_NAMES = {
  minimumRunSeconds: "notify-minimum-run-seconds",
  minimumAwaySeconds: "notify-minimum-away-seconds",
  urgency: "notify-urgency",
  expirySeconds: "notify-expiry-seconds",
  hidePrompt: "notify-hide-prompt",
} as const;

export type NotificationUrgency = "low" | "normal" | "critical";

export type NotifyConfig = {
  minimumRunMs: number;
  minimumAwayMs: number;
  urgency: NotificationUrgency;
  expiryMs: number;
  showPrompt: boolean;
};

export const DEFAULT_CONFIG: NotifyConfig = {
  minimumRunMs: 10_000,
  minimumAwayMs: 5_000,
  urgency: "normal",
  expiryMs: 10_000,
  showPrompt: true,
};

type ConfigResult =
  | { ok: true; config: NotifyConfig }
  | { ok: false; error: string };

function seconds(value: unknown, flag: string, fallbackMs: number): number | string {
  if (value === undefined) return fallbackMs;
  if (typeof value !== "string" || value.trim() === "") {
    return `--${flag} must be a finite non-negative number`;
  }
  const parsed = Number(value);
  const milliseconds = parsed * 1000;
  return Number.isFinite(milliseconds) && parsed >= 0
    ? milliseconds
    : `--${flag} must be a finite non-negative number`;
}

export function parseConfig(values: Record<string, unknown>): ConfigResult {
  const minimumRunMs = seconds(
    values[FLAG_NAMES.minimumRunSeconds],
    FLAG_NAMES.minimumRunSeconds,
    DEFAULT_CONFIG.minimumRunMs,
  );
  if (typeof minimumRunMs === "string") return { ok: false, error: minimumRunMs };

  const minimumAwayMs = seconds(
    values[FLAG_NAMES.minimumAwaySeconds],
    FLAG_NAMES.minimumAwaySeconds,
    DEFAULT_CONFIG.minimumAwayMs,
  );
  if (typeof minimumAwayMs === "string") return { ok: false, error: minimumAwayMs };

  const expiryMs = seconds(
    values[FLAG_NAMES.expirySeconds],
    FLAG_NAMES.expirySeconds,
    DEFAULT_CONFIG.expiryMs,
  );
  if (typeof expiryMs === "string") return { ok: false, error: expiryMs };

  const urgency = values[FLAG_NAMES.urgency] ?? DEFAULT_CONFIG.urgency;
  if (urgency !== "low" && urgency !== "normal" && urgency !== "critical") {
    return { ok: false, error: `--${FLAG_NAMES.urgency} must be low, normal, or critical` };
  }

  const hidePrompt = values[FLAG_NAMES.hidePrompt] ?? false;
  if (typeof hidePrompt !== "boolean") {
    return { ok: false, error: `--${FLAG_NAMES.hidePrompt} must be boolean` };
  }

  return {
    ok: true,
    config: {
      minimumRunMs,
      minimumAwayMs,
      urgency,
      expiryMs,
      showPrompt: !hidePrompt,
    },
  };
}

export default function heuristicNotify(pi: ExtensionAPI): void {
  const flags = [
    [FLAG_NAMES.minimumRunSeconds, "Minimum Pi run duration in seconds", "string", "10"],
    [FLAG_NAMES.minimumAwaySeconds, "Minimum continuously unfocused duration in seconds", "string", "5"],
    [FLAG_NAMES.urgency, "Notification urgency: low, normal, or critical", "string", "normal"],
    [FLAG_NAMES.expirySeconds, "Notification expiry time in seconds", "string", "10"],
    [FLAG_NAMES.hidePrompt, "Hide the last user prompt in notifications", "boolean", false],
  ] as const;
  for (const [name, description, type, defaultValue] of flags) {
    pi.registerFlag(name, { description, type, default: defaultValue });
  }

  pi.on("session_start", (_event, ctx) => {
    const result = parseConfig(Object.fromEntries(
      Object.values(FLAG_NAMES).map((name) => [name, pi.getFlag(name)]),
    ));
    if (!result.ok) ctx.ui.notify(`pi-heuristic-notify disabled: ${result.error}`, "error");
  });
}
