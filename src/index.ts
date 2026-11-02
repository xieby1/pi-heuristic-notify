import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function writeNotification(data: string): void {
  if (process.stdout.isTTY) return writeTerminal(data);
  writeFileSync("/dev/tty", data);
}

export type NotificationUrgency = "low" | "normal" | "critical";

export type NotifyConfig = {
  minimumRunMs: number;
  minimumAwayMs: number;
  urgency: NotificationUrgency;
  expiryMs: number;
  showPrompt: boolean;
  notifyOnQuestion: boolean;
};

export const DEFAULT_CONFIG: NotifyConfig = {
  minimumRunMs: 10_000,
  minimumAwayMs: 5_000,
  urgency: "normal",
  expiryMs: 10_000,
  showPrompt: true,
  notifyOnQuestion: true,
};

type ConfigResult =
  | { ok: true; config: NotifyConfig }
  | { ok: false; error: string };

function seconds(value: unknown, property: string, fallbackMs: number): number | string {
  if (value === undefined) return fallbackMs;
  const milliseconds = typeof value === "number" ? value * 1_000 : NaN;
  return Number.isFinite(milliseconds) && value as number >= 0
    ? milliseconds
    : `${property} must be a finite non-negative number`;
}

export function parseConfig(values: Record<string, unknown>): ConfigResult {
  const minimumRunMs = seconds(values.minimumRunSeconds, "minimumRunSeconds", DEFAULT_CONFIG.minimumRunMs);
  if (typeof minimumRunMs === "string") return { ok: false, error: minimumRunMs };

  const minimumAwayMs = seconds(values.minimumAwaySeconds, "minimumAwaySeconds", DEFAULT_CONFIG.minimumAwayMs);
  if (typeof minimumAwayMs === "string") return { ok: false, error: minimumAwayMs };

  const expiryMs = seconds(values.expirySeconds, "expirySeconds", DEFAULT_CONFIG.expiryMs);
  if (typeof expiryMs === "string") return { ok: false, error: expiryMs };

  const urgency = values.urgency ?? DEFAULT_CONFIG.urgency;
  if (urgency !== "low" && urgency !== "normal" && urgency !== "critical") {
    return { ok: false, error: "urgency must be low, normal, or critical" };
  }

  const showPrompt = values.showPrompt ?? DEFAULT_CONFIG.showPrompt;
  if (typeof showPrompt !== "boolean") {
    return { ok: false, error: "showPrompt must be boolean" };
  }
  const notifyOnQuestion = values.notifyOnQuestion ?? DEFAULT_CONFIG.notifyOnQuestion;
  if (typeof notifyOnQuestion !== "boolean") {
    return { ok: false, error: "notifyOnQuestion must be boolean" };
  }

  return {
    ok: true,
    config: { minimumRunMs, minimumAwayMs, urgency, expiryMs, showPrompt, notifyOnQuestion },
  };
}

export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-heuristic-notify.json");
}

export function loadConfig(agentDir = getAgentDir()): ConfigResult {
  const path = configPath(agentDir);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, config: DEFAULT_CONFIG };
    return { ok: false, error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    const values: unknown = JSON.parse(contents);
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      return { ok: false, error: `${path}: configuration must be a JSON object` };
    }
    const result = parseConfig(values as Record<string, unknown>);
    return result.ok ? result : { ok: false, error: `${path}: ${result.error}` };
  } catch (error) {
    return { ok: false, error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type EligibleRun = {
  prompt: string;
  runDurationMs: number;
  outcome: "complete" | "failed";
};

export type NotificationContent = {
  title: string;
  body: string;
  urgency: NotificationUrgency;
  expiryMs: number;
};

export type NotificationOrigin = {
  ghostty: boolean;
};

type DeliveryResult =
  | { ok: true }
  | { ok: false; error?: string; aborted?: boolean };

function commandError(command: string, result: { code: number; stderr: string; stdout: string }): string {
  const detail = (result.stderr || result.stdout).trim();
  return `${command}: ${detail || `exit code ${result.code}`}`;
}

export async function deliverNotification(
  pi: ExtensionAPI,
  notification: NotificationContent,
  origin: NotificationOrigin,
  signal: AbortSignal,
  platform = process.platform,
  write: (data: string) => void = writeNotification,
): Promise<DeliveryResult> {
  if (signal.aborted) return { ok: false, aborted: true };
  let ghosttyError: string | undefined;
  if (origin.ghostty) {
    try {
      const title = notification.title.replace(/[;\x00-\x1f\x7f-\x9f]/g, " ");
      const body = notification.body.replace(/\r?\n/g, " | ").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
      const osc = `${ESC}]777;notify;${title};${body}\x07`;
      write(osc);
      return { ok: true };
    } catch (error) {
      ghosttyError = `Ghostty: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (platform !== "linux") return { ok: false, error: ghosttyError ?? "no supported notification backend" };
  try {
    const result = await pi.exec("notify-send", [
      "--app-name=Pi",
      "--icon=system-monitor",
      `--urgency=${notification.urgency}`,
      `--expire-time=${Math.round(notification.expiryMs)}`,
      notification.title,
      notification.body,
    ], { signal });
    if (signal.aborted) return { ok: false, aborted: true };
    if (result.code === 0) return { ok: true };
    return {
      ok: false,
      error: [ghosttyError, commandError("notify-send", result)].filter(Boolean).join("; "),
    };
  } catch (error) {
    if (signal.aborted) return { ok: false, aborted: true };
    return {
      ok: false,
      error: [ghosttyError, `notify-send: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("; "),
    };
  }
}

export function sanitizePrompt(prompt: string, maxCodePoints = 160): string {
  const normalized = stripVTControlCharacters(prompt)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(normalized);
  return characters.length <= maxCodePoints
    ? normalized
    : `${characters.slice(0, maxCodePoints - 3).join("")}...`;
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${Math.floor(durationMs / 100) / 10}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1_000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function buildNotification(run: EligibleRun, config: NotifyConfig): NotificationContent {
  const duration = `Duration: ${formatDuration(run.runDurationMs)}`;
  const prompt = sanitizePrompt(run.prompt) || "No prompt";
  return {
    title: run.outcome === "failed" ? "Pi run failed" : "Pi run complete",
    body: config.showPrompt ? `Prompt: ${prompt}\n${duration}` : duration,
    urgency: config.urgency,
    expiryMs: config.expiryMs,
  };
}

export function buildQuestionNotification(question: string, prompt: string, elapsedMs: number, config: NotifyConfig): NotificationContent {
  const duration = `Duration: ${formatDuration(elapsedMs)}`;
  const shortQuestion = sanitizePrompt(question);
  const details = [shortQuestion && `Question: ${shortQuestion}`, `Prompt: ${sanitizePrompt(prompt) || "No prompt"}`, duration].filter(Boolean).join("\n");
  return {
    title: "Pi needs your input",
    body: config.showPrompt ? details : duration,
    urgency: config.urgency,
    expiryMs: config.expiryMs,
  };
}

type Runtime = {
  now?: () => number;
  writeTerminal?: (data: string) => void;
  notify?: (notification: NotificationContent) => void | Promise<void>;
  schedule?: (delayMs: number, callback: () => void) => () => void;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  loadConfig?: () => ConfigResult;
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
  const env = runtime.env ?? process.env;
  const origin: NotificationOrigin = { ghostty: env.TERM_PROGRAM === "ghostty" };
  const controllers = new Set<AbortController>();
  let config: NotifyConfig | undefined;
  let reportError: ((message: string) => void) | undefined;
  let runStart: number | undefined;
  let lastRunDurationMs: number | undefined;
  let suppression = "unknown focus";
  let prompt = "";
  let agentEnded = false;
  let stopReason: string | undefined;
  let cancelPending: (() => void) | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let unsubscribeQuestions: (() => void) | undefined;
  const questions = new Map<string, { question: string; blocked?: boolean; cancel?: () => void; notified?: boolean; suppressed?: boolean }>();

  const abortDeliveries = () => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };
  const send = async (notification: NotificationContent) => {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      return await deliverNotification(
        pi,
        notification,
        origin,
        controller.signal,
        runtime.platform,
        runtime.writeTerminal ?? writeNotification,
      );
    } finally {
      controllers.delete(controller);
    }
  };
  const notify = runtime.notify ?? ((notification: NotificationContent) => {
    void send(notification).then((result) => {
      if (!result.ok && !result.aborted) reportError?.(result.error ?? "unknown delivery failure");
    });
  });
  const cancelEligibility = () => {
    cancelPending?.();
    cancelPending = undefined;
  };
  const resetRun = () => {
    runStart = undefined;
    agentEnded = false;
    stopReason = undefined;
  };
  const clearQuestions = () => {
    for (const question of questions.values()) question.cancel?.();
    questions.clear();
  };
  const scheduleQuestion = (id: string) => {
    const question = questions.get(id);
    if (!config?.notifyOnQuestion || !question?.blocked || question.cancel || question.notified || question.suppressed || runStart === undefined) return;
    const awayMs = continuousAwayMs(focus, now());
    if (awayMs === undefined) return;
    question.cancel = schedule(Math.max(config.minimumAwayMs - awayMs, 0), () => {
      delete question.cancel;
      if (questions.get(id) !== question || !question.blocked || !config?.notifyOnQuestion || question.suppressed || runStart === undefined) return;
      const readyAt = now();
      const currentAwayMs = continuousAwayMs(focus, readyAt);
      if (currentAwayMs === undefined) return;
      if (currentAwayMs < config.minimumAwayMs) {
        scheduleQuestion(id);
        return;
      }
      question.notified = true;
      void notify(buildQuestionNotification(question.question, prompt, readyAt - runStart, config));
    });
  };
  const listenForQuestions = () => {
    if (unsubscribeQuestions) return;
    const stopPrompt = pi.events.on("rpiv:ask-user:prompt", (data) => {
      const payload = data as { toolCallId?: unknown; questions?: Array<{ question?: unknown }> } | null;
      if (!payload || typeof payload.toolCallId !== "string" || !payload.toolCallId) return;
      const question = questions.get(payload.toolCallId) ?? { question: "" };
      question.question = typeof payload.questions?.[0]?.question === "string" ? payload.questions[0].question : "";
      questions.set(payload.toolCallId, question);
    });
    const stopBlocked = pi.events.on("rpiv:ask-user:blocked", (data) => {
      const payload = data as { toolCallId?: unknown; active?: unknown } | null;
      if (!payload || typeof payload.toolCallId !== "string" || !payload.toolCallId) return;
      if (payload.active === false) {
        questions.get(payload.toolCallId)?.cancel?.();
        questions.delete(payload.toolCallId);
      } else if (payload.active === true) {
        const question = questions.get(payload.toolCallId) ?? { question: "" };
        if (question.blocked) return;
        question.blocked = true;
        question.suppressed = !focus.observed || focus.focused;
        questions.set(payload.toolCallId, question);
        scheduleQuestion(payload.toolCallId);
      }
    });
    unsubscribeQuestions = () => { stopPrompt(); stopBlocked(); };
  };
  pi.registerCommand("notify-check", {
    description: "Show notification state and suppression reason",
    handler: async (_args, ctx) => {
      const at = now();
      const awayMs = continuousAwayMs(focus, at);
      const focusState = !focus.observed ? "unknown" : focus.focused ? "focused" : "unfocused";
      const runDurationMs = runStart === undefined ? lastRunDurationMs : at - runStart;
      const backend = origin.ghostty
        ? "Ghostty OSC 777"
        : (runtime.platform ?? process.platform) === "linux" ? "notify-send" : "unsupported";
      const configText = config
        ? `run >= ${formatDuration(config.minimumRunMs)}; away >= ${formatDuration(config.minimumAwayMs)}; urgency ${config.urgency}; expiry ${formatDuration(config.expiryMs)}; prompt ${config.showPrompt ? "shown" : "hidden"}; questions ${config.notifyOnQuestion ? "on" : "off"}`
        : "invalid";
      ctx.ui.notify([
        `Config file: ${configPath()}`,
        `Config: ${configText}`,
        `Focus: terminal events; ${focusState}; away ${awayMs === undefined ? "n/a" : formatDuration(awayMs)}`,
        `Run: ${runDurationMs === undefined ? "n/a" : formatDuration(runDurationMs)}`,
        `Pending delivery: ${cancelPending ? "yes" : "no"}`,
        `Backend: ${backend}`,
        `Suppression: ${suppression}`,
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("notify-test", {
    description: "Send a test desktop notification",
    handler: async (_args, ctx) => {
      if (!config) {
        ctx.ui.notify("Test notification failed: invalid configuration", "error");
        return;
      }
      const pending = send({
        title: "Pi notification test",
        body: "Desktop notifications are working.",
        urgency: config.urgency,
        expiryMs: config.expiryMs,
      });
      const result = await pending;
      if (result.ok) ctx.ui.notify(origin.ghostty
        ? "Test sequence written; Ghostty may suppress the notification"
        : "Test notification sent", "info");
      else if (!result.aborted) ctx.ui.notify(`Test notification failed: ${result.error ?? "unknown delivery failure"}`, "error");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    abortDeliveries();
    cancelEligibility();
    clearQuestions();
    resetRun();
    lastRunDurationMs = undefined;
    Object.assign(focus, createFocusState());
    reportError = (message) => ctx.ui.notify(`pi-heuristic-notify: ${message}`, "error");
    const result = (runtime.loadConfig ?? loadConfig)();
    config = result.ok ? result.config : undefined;
    suppression = result.ok ? "unknown focus" : "invalid config";
    if (!result.ok) ctx.ui.notify(`pi-heuristic-notify disabled: ${result.error}`, "error");
    listenForQuestions();

    if (ctx.mode !== "tui" || unsubscribeInput) return;
    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      if (data.includes(`${ESC}[I`)) {
        cancelEligibility();
        for (const question of questions.values()) {
          question.cancel?.();
          delete question.cancel;
          question.suppressed = true;
        }
        suppression = "focused";
      }
      const output = scanFocusInput(data, focus, now());
      if (data.includes(`${ESC}[O`)) for (const id of questions.keys()) scheduleQuestion(id);
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
    suppression = "run in progress";
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

    lastRunDurationMs = startedAt === undefined ? undefined : settledAt - startedAt;
    if (!config) {
      suppression = "invalid config";
      return;
    }
    if (startedAt === undefined || !ended) {
      suppression = "interrupted";
      return;
    }
    if (finalStopReason === "aborted") {
      suppression = "aborted";
      return;
    }
    const settledConfig = config;
    const runDurationMs = lastRunDurationMs!;
    if (runDurationMs < settledConfig.minimumRunMs) {
      suppression = "short run";
      return;
    }
    const awayMs = continuousAwayMs(focus, settledAt);
    if (awayMs === undefined) {
      suppression = focus.observed ? "focused" : "unknown focus";
      return;
    }

    const minimumAwayMs = settledConfig.minimumAwayMs;
    const candidate: EligibleRun = {
      prompt: settledPrompt,
      runDurationMs,
      outcome: finalStopReason === "error" ? "failed" : "complete",
    };
    const deliver = () => {
      suppression = "eligible";
      void notify(buildNotification(candidate, settledConfig));
    };
    if (awayMs >= minimumAwayMs) {
      deliver();
      return;
    }

    suppression = "waiting for away threshold";
    cancelPending = schedule(minimumAwayMs - awayMs, () => {
      cancelPending = undefined;
      const currentAwayMs = continuousAwayMs(focus, now());
      if (currentAwayMs !== undefined && currentAwayMs >= minimumAwayMs) {
        deliver();
      }
    });
  });

  pi.on("session_shutdown", () => {
    cancelEligibility();
    clearQuestions();
    unsubscribeQuestions?.();
    unsubscribeQuestions = undefined;
    abortDeliveries();
    reportError = undefined;
    resetRun();
    if (!unsubscribeInput) return;
    unsubscribeInput();
    unsubscribeInput = undefined;
    write(DISABLE_FOCUS_REPORTING);
    Object.assign(focus, createFocusState());
  });
}
