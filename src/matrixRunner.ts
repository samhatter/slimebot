import { LogService, MatrixClient } from "matrix-bot-sdk";

type RunnerConfig = {
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

function loadConfig(): RunnerConfig {
  return {
    homeserverUrl: requiredEnv("MATRIX_HOMESERVER_URL"),
    accessToken: requiredEnv("MATRIX_ACCESS_TOKEN"),
    botUserId: process.env.MATRIX_BOT_USER_ID,
    allowedInviteSender: process.env.MATRIX_ALLOWED_INVITE_SENDER
  };
}

export async function startMatrixBotRunner(): Promise<void> {
  const config = loadConfig();
  const client = new MatrixClient(config.homeserverUrl, config.accessToken);

  client.on("room.invite", async (roomId: string, event: unknown) => {
    const rawEvent = event as Record<string, unknown>;
    const sender = rawEvent["sender"] as string | undefined;
    if (!sender) {
      console.log(`[room.invite] ignored room=${roomId} sender=unknown`);
      return;
    }

    if (config.allowedInviteSender && sender !== config.allowedInviteSender) {
      console.log(
        `[room.invite] ignored room=${roomId} sender=${sender} reason=sender_not_allowed allowed=${config.allowedInviteSender}`
      );
      return;
    }

    try {
      await client.joinRoom(roomId);
      console.log(`[room.invite] joined room=${roomId} sender=${sender}`);
    } catch (error) {
      LogService.warn("matrix-runner", `Failed to join invited room ${roomId}: ${String(error)}`);
    }
  });

  client.on("room.message", async (roomId: string, event: unknown) => {
    const rawEvent = event as Record<string, unknown>;
    const sender = rawEvent["sender"] as string | undefined;
    if (!sender || sender === config.botUserId) {
      return;
    }

    const content = rawEvent["content"] as { body?: string; msgtype?: string } | undefined;
    if (!content || content.msgtype !== "m.text") {
      return;
    }

    console.log(`[room.message] room=${roomId} sender=${sender} body=${content.body ?? ""}`);
  });

  await client.start();

  LogService.info("matrix-runner", "Bot runner started");
}
