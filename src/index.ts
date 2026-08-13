import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ESC = "\x1b";
const ENABLE_FOCUS_REPORTING = `${ESC}[?1004h`;
const DISABLE_FOCUS_REPORTING = `${ESC}[?1004l`;

export type FocusState = {
  focused: boolean;
  observed: boolean;
  unfocusedSince: number | undefined;
};

export function createFocusState(): FocusState {
  return { focused: true, observed: false, unfocusedSince: undefined };
}

export function scanFocusInput(data: string, state: FocusState, now: number): string | null | undefined {
  let matched = false;
  const output = data.replace(/\x1b\[([IO])/g, (_sequence, event: string) => {
    matched = true;
    if (event === "I") {
      state.focused = true;
      state.observed = true;
      state.unfocusedSince = undefined;
    } else {
      if (!state.observed || state.focused) state.unfocusedSince = now;
      state.focused = false;
      state.observed = true;
    }
    return "";
  });
  return matched ? output || null : undefined;
}

export function continuousAwayMs(state: FocusState, now: number): number | undefined {
  return state.observed && !state.focused && state.unfocusedSince !== undefined
    ? now - state.unfocusedSince
    : undefined;
}

function writeTerminal(data: string): void {
  try {
    writeFileSync("/dev/tty", data);
  } catch {
    process.stdout.write(data);
  }
}

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

export type EligibleRun = {
  prompt: string;
  runDurationMs: number;
};

type Runtime = {
  now?: () => number;
  writeTerminal?: (data: string) => void;
  onEligible?: (run: EligibleRun) => void | Promise<void>;
  schedule?: (delayMs: number, callback: () => void) => () => void;
};

export default function heuristicNotify(
  pi: ExtensionAPI,
  runtime: Runtime = {},
): void {
  const now = runtime.now ?? Date.now;
  const write = runtime.writeTerminal ?? writeTerminal;
  const schedule = runtime.schedule ?? ((delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  const focus = createFocusState();
  let config: NotifyConfig | undefined;
  let runStart: number | undefined;
  let prompt = "";
  let agentEnded = false;
  let stopReason: string | undefined;
  let cancelPending: (() => void) | undefined;
  let unsubscribeInput: (() => void) | undefined;

  const cancelEligibility = () => {
    cancelPending?.();
    cancelPending = undefined;
  };
  const resetRun = () => {
    runStart = undefined;
    agentEnded = false;
    stopReason = undefined;
  };
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
    config = result.ok ? result.config : undefined;
    if (!result.ok) ctx.ui.notify(`pi-heuristic-notify disabled: ${result.error}`, "error");

    if (ctx.mode !== "tui" || unsubscribeInput) return;
    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      if (data.includes(`${ESC}[I`)) cancelEligibility();
      const output = scanFocusInput(data, focus, now());
      if (output === undefined) return undefined;
      return output === null ? { consume: true } : { data: output };
    });
    write(ENABLE_FOCUS_REPORTING);
  });

  pi.on("before_agent_start", (event) => {
    prompt = event.prompt;
  });

  pi.on("agent_start", () => {
    cancelEligibility();
    runStart ??= now();
    agentEnded = false;
    stopReason = undefined;
  });

  pi.on("agent_end", (event) => {
    agentEnded = true;
    stopReason = [...event.messages].reverse().find((message) => message.role === "assistant")?.stopReason;
  });

  pi.on("agent_settled", () => {
    const settledAt = now();
    const startedAt = runStart;
    const ended = agentEnded;
    const finalStopReason = stopReason;
    const settledPrompt = prompt;
    resetRun();

    if (!config || startedAt === undefined || !ended || finalStopReason === "aborted") return;
    const runDurationMs = settledAt - startedAt;
    if (runDurationMs < config.minimumRunMs) return;
    const awayMs = continuousAwayMs(focus, settledAt);
    if (awayMs === undefined) return;

    const minimumAwayMs = config.minimumAwayMs;
    const candidate = { prompt: settledPrompt, runDurationMs };
    if (awayMs >= minimumAwayMs) {
      void runtime.onEligible?.(candidate);
      return;
    }

    cancelPending = schedule(minimumAwayMs - awayMs, () => {
      cancelPending = undefined;
      const currentAwayMs = continuousAwayMs(focus, now());
      if (currentAwayMs !== undefined && currentAwayMs >= minimumAwayMs) {
        void runtime.onEligible?.(candidate);
      }
    });
  });

  pi.on("session_shutdown", () => {
    cancelEligibility();
    resetRun();
    if (!unsubscribeInput) return;
    unsubscribeInput();
    unsubscribeInput = undefined;
    write(DISABLE_FOCUS_REPORTING);
    Object.assign(focus, createFocusState());
  });
}
