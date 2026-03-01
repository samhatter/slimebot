export type ControllerCommand = {
  name: string;
  args: string[];
};

const commandAliases: Record<string, string> = {
  i: "interrupt",
  a: "approve",
  s: "skip"
};

const supportedCommands = new Set<string>([
  "help",
  "new",
  "resume",
  "threads",
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
  "account"
]);

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

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function getAuthUrlFromLoginResult(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) {
    return undefined;
  }

  const authUrl = record["authUrl"];
  return typeof authUrl === "string" ? authUrl : undefined;
}