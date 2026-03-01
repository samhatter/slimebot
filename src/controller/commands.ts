export type ControllerCommand = {
  name: string;
  args: string[];
};

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
  const commandName = firstToken.toLowerCase();
  if (
    commandName !== "help" &&
    commandName !== "new" &&
    commandName !== "login" &&
    commandName !== "callback" &&
    commandName !== "models" &&
    commandName !== "account"
  ) {
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