/**
 * @fileoverview Channel-level command parsing for controller-dispatchable commands.
 */

/** Parsed controller command with canonical name and args. */
export type ControllerCommand = {
  name: string;
  args: string[];
};

const commandAliases: Record<string, string> = {
  i: "interrupt",
  a: "approve",
  s: "skip",
  r: "reasoning",
  m: "model",
};

const supportedCommands = new Set<string>([
  "help",
  "new",
  "resume",
  "thread",
  "rollback",
  "compact",
  "archive",
  "unarchive",
  "interrupt",
  "approve",
  "skip",
  "login",
  "callback",
  "models",
  "model",
  "account",
  "reasoning"
]);

/** Parses a raw room message into a supported controller command, if any. */
export function parseControllerCommand(body: string): ControllerCommand | undefined {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }

  const tokens = trimmed.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }

  const firstToken = tokens[0].startsWith("!") ? tokens[0].slice(1) : tokens[0];
  const commandName = commandAliases[firstToken.toLowerCase()] ?? firstToken.toLowerCase();
  if (!supportedCommands.has(commandName)) {
    return undefined;
  }

  return {
    name: commandName,
    args: tokens.slice(1)
  };
}