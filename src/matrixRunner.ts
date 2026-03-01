import { LogService, MatrixClient } from "matrix-bot-sdk";
import { CodexAppServerProcess } from "./codexAppServerProcess.js";

type RunnerConfig = {
  homeserverUrl: string;
  accessToken: string;
  botUserId?: string;
  allowedInviteSender?: string;
  codexAppServerCommand?: string;
  codexAppServerArgs: string[];
};

type MatrixReplyMessage = {
  type: "matrix.reply";
  roomId: string;
  body: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMatrixReplyMessage(value: unknown): value is MatrixReplyMessage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value["type"] === "matrix.reply" &&
    typeof value["roomId"] === "string" &&
    typeof value["body"] === "string"
  );
}

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
    allowedInviteSender: process.env.MATRIX_ALLOWED_INVITE_SENDER,
    codexAppServerCommand: process.env.CODEX_APP_SERVER_COMMAND,
    codexAppServerArgs: process.env.CODEX_APP_SERVER_ARGS?.split(/\s+/u).filter(Boolean) ?? []
  };
}

export async function startMatrixBotRunner(): Promise<void> {
  const config = loadConfig();
  const client = new MatrixClient(config.homeserverUrl, config.accessToken);
  const codexAppServer = config.codexAppServerCommand
    ? new CodexAppServerProcess(config.codexAppServerCommand, config.codexAppServerArgs)
    : undefined;

  if (codexAppServer) {
    codexAppServer.on("start", (pid: number) => {
      LogService.info("matrix-runner", `Codex app server started pid=${pid}`);
    });

    codexAppServer.on("stdout", (line: string) => {
      LogService.info("matrix-runner", `[codex.stdout] ${line}`);
    });

    codexAppServer.on("stderr", (line: string) => {
      LogService.warn("matrix-runner", `[codex.stderr] ${line}`);
    });

    codexAppServer.on("error", (error: Error) => {
      LogService.error("matrix-runner", `Codex app server error: ${String(error)}`);
    });

    codexAppServer.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      LogService.warn(
        "matrix-runner",
        `Codex app server exited code=${String(code)} signal=${String(signal)}`
      );
    });

    codexAppServer.on("message", async (message: unknown) => {
      if (!isMatrixReplyMessage(message)) {
        return;
      }

      try {
        await client.sendMessage(message.roomId, {
          msgtype: "m.text",
          body: message.body
        });
      } catch (error) {
        LogService.warn(
          "matrix-runner",
          `Failed to send Codex reply to room ${message.roomId}: ${String(error)}`
        );
      }
    });

    codexAppServer.start();
  }

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

    if (codexAppServer && content.body) {
      try {
        codexAppServer.send({
          type: "matrix.room.message",
          roomId,
          sender,
          body: content.body,
          originServerTs: rawEvent["origin_server_ts"]
        });
      } catch (error) {
        LogService.warn("matrix-runner", `Failed to forward Matrix message to Codex: ${String(error)}`);
      }
    }
  });

  const shutdownCodexServer = (): void => {
    codexAppServer?.stop("SIGTERM");
  };

  process.once("SIGINT", shutdownCodexServer);
  process.once("SIGTERM", shutdownCodexServer);

  await client.start();

  LogService.info("matrix-runner", "Bot runner started");
}
