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
  if (commandName !== "login" && commandName !== "callback") {
    return undefined;
  }

  return {
    name: commandName,
    args: tokens.slice(1)
  };
}