export type MatrixConfig = {
  homeserverUrl: string;
  accessToken: string;
  botUserId?: string;
  allowedInviteSender?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadMatrixConfig(): MatrixConfig {
  return {
    homeserverUrl: requiredEnv("MATRIX_HOMESERVER_URL"),
    accessToken: requiredEnv("MATRIX_ACCESS_TOKEN"),
    botUserId: process.env.MATRIX_BOT_USER_ID,
    allowedInviteSender: process.env.MATRIX_ALLOWED_INVITE_SENDER
  };
}