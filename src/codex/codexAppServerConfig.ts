export type CodexAppServerConfig = {
  command?: string;
  args: string[];
};

export function loadCodexAppServerConfig(): CodexAppServerConfig {
  return {
    command: process.env.CODEX_APP_SERVER_COMMAND,
    args: process.env.CODEX_APP_SERVER_ARGS?.split(/\s+/u).filter(Boolean) ?? []
  };
}