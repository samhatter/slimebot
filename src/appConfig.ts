export type MatrixConfig = {
  homeserverUrl: string;
  accessToken: string;
  botUserId?: string;
  allowedInviteSender?: string;
};

export type CodexAppServerConfig = {
  command?: string;
  args: string[];
};

export type AppConfig = {
  matrix: MatrixConfig;
  codex: CodexAppServerConfig;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function loadAppConfig(): AppConfig {
  return {
    matrix: {
      homeserverUrl: requiredEnv("MATRIX_HOMESERVER_URL"),
      accessToken: requiredEnv("MATRIX_ACCESS_TOKEN"),
      botUserId: process.env.MATRIX_BOT_USER_ID,
      allowedInviteSender: process.env.MATRIX_ALLOWED_INVITE_SENDER
    },
    codex: {
      command: process.env.CODEX_APP_SERVER_COMMAND,
      args: process.env.CODEX_APP_SERVER_ARGS?.split(/\s+/u).filter(Boolean) ?? []
    }
  };
}