import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
  ExtensionHandler,
  RegisteredCommand,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";

type AnyHandler = ExtensionHandler<ExtensionEvent, unknown>;
type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;

export function createExtensionHarness(harnessOptions: {
  exec?: (
    call: { command: string; args: string[]; options: ExecOptions | undefined },
  ) => ExecResult | Promise<ExecResult>;
} = {}) {
  const handlers = new Map<string, AnyHandler[]>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const commands = new Map<string, Command>();
  const terminalInputHandlers: TerminalInputHandler[] = [];
  const execCalls: Array<{ command: string; args: string[]; options: ExecOptions | undefined }> = [];
  const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];

  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
      onTerminalInput(handler: TerminalInputHandler) {
        terminalInputHandlers.push(handler);
        return () => {
          const index = terminalInputHandlers.indexOf(handler);
          if (index !== -1) terminalInputHandlers.splice(index, 1);
        };
      },
    },
  } as unknown as ExtensionCommandContext;

  const pi = {
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]);
        return () => eventHandlers.set(channel, (eventHandlers.get(channel) ?? []).filter((item) => item !== handler));
      },
      emit(channel: string, data: unknown) {
        for (const handler of eventHandlers.get(channel) ?? []) handler(data);
      },
    },
    on(event: string, handler: AnyHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
      const call = { command, args, options };
      execCalls.push(call);
      return harnessOptions.exec?.(call) ?? { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    context,
    handlers,
    emitEvent(channel: string, data: unknown) { pi.events.emit(channel, data); },
    eventListenerCount(channel: string) { return eventHandlers.get(channel)?.length ?? 0; },
    commands,
    execCalls,
    notifications,
    async emit(event: string, value: object, override: Partial<ExtensionContext> = {}) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(value as ExtensionEvent, { ...context, ...override });
      }
    },
    async runCommand(name: string, args = "") {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      await command.handler(args, context);
    },
    sendTerminalInput(data: string) {
      return terminalInputHandlers.map((handler) => handler(data));
    },
  };
}
