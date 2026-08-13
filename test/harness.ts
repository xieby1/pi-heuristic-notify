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
type Flag = {
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
};

export function createExtensionHarness(options: {
  flags?: Record<string, boolean | string>;
} = {}) {
  const handlers = new Map<string, AnyHandler[]>();
  const commands = new Map<string, Command>();
  const flags = new Map<string, Flag>();
  const flagValues = new Map(Object.entries(options.flags ?? {}));
  const terminalInputHandlers: TerminalInputHandler[] = [];
  const execCalls: Array<{ command: string; args: string[]; options: ExecOptions | undefined }> = [];
  const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];

  const context = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
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
    on(event: string, handler: AnyHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerFlag(name: string, flag: Flag) {
      flags.set(name, flag);
      if (flag.default !== undefined && !flagValues.has(name)) flagValues.set(name, flag.default);
    },
    getFlag(name: string) {
      return flagValues.get(name);
    },
    async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
      execCalls.push({ command, args, options });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    context,
    commands,
    flags,
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
