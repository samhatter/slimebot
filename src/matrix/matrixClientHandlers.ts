import { LogService, MatrixClient } from "matrix-bot-sdk";
import { CodexAppServerProcess } from "../codex/codexAppServerProcess.js";

type MatrixRoomInviteHandlerOptions = {
  client: MatrixClient;
  allowedInviteSender?: string;
};

type MatrixRoomMessageHandlerOptions = {
  client: MatrixClient;
  botUserId?: string;
  codexAppServer?: CodexAppServerProcess;
};

type MatrixCommand = {
  name: string;
  args: string[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function parseMatrixCommand(body: string): MatrixCommand | undefined {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }

  const rawTokens = trimmed.split(/\s+/u).filter(Boolean);
  if (rawTokens.length === 0) {
    return undefined;
  }

  const firstToken = rawTokens[0].startsWith("!") ? rawTokens[0].slice(1) : rawTokens[0];
  const commandName = firstToken.toLowerCase();

  if (commandName !== "login") {
    return undefined;
  }

  return {
    name: commandName,
    args: rawTokens.slice(1)
  };
}

function getAuthUrlFromLoginStartResult(result: unknown): string | undefined {
  const resultRecord = asRecord(result);
  if (!resultRecord) {
    return undefined;
  }

  const authUrl = resultRecord["authUrl"];
  if (typeof authUrl === "string") {
    return authUrl;
  }

  return undefined;
}

async function sendTextMessage(client: MatrixClient, roomId: string, body: string): Promise<void> {
  await client.sendMessage(roomId, {
    msgtype: "m.text",
    body
  });
}

export function createMatrixRoomInviteHandler(options: MatrixRoomInviteHandlerOptions) {
  return async (roomId: string, event: unknown): Promise<void> => {
    const rawEvent = event as Record<string, unknown>;
    const sender = rawEvent["sender"] as string | undefined;
    if (!sender) {
      console.log(`[room.invite] ignored room=${roomId} sender=unknown`);
      return;
    }

    if (options.allowedInviteSender && sender !== options.allowedInviteSender) {
      console.log(
        `[room.invite] ignored room=${roomId} sender=${sender} reason=sender_not_allowed allowed=${options.allowedInviteSender}`
      );
      return;
    }

    try {
      await options.client.joinRoom(roomId);
      console.log(`[room.invite] joined room=${roomId} sender=${sender}`);
    } catch (error) {
      LogService.warn("matrix-runner", `Failed to join invited room ${roomId}: ${String(error)}`);
    }
  };
}

export function createMatrixRoomMessageHandler(options: MatrixRoomMessageHandlerOptions) {
  return async (roomId: string, event: unknown): Promise<void> => {
    const rawEvent = event as Record<string, unknown>;
    const sender = rawEvent["sender"] as string | undefined;
    if (!sender || sender === options.botUserId) {
      return;
    }

    const content = rawEvent["content"] as { body?: string; msgtype?: string } | undefined;
    if (!content || content.msgtype !== "m.text") {
      return;
    }

    const body = content.body ?? "";

    console.log(`[room.message] room=${roomId} sender=${sender} body=${body}`);

    const command = parseMatrixCommand(body);
    if (command) {
      if (!options.codexAppServer) {
        await sendTextMessage(options.client, roomId, "Codex app server is not configured.");
        return;
      }

      if (command.name === "login") {
        try {
          const loginResult = await options.codexAppServer.accountLoginStart({
            type: "chatgpt"
          });

          const authUrl = getAuthUrlFromLoginStartResult(loginResult);
          if (!authUrl) {
            await sendTextMessage(options.client, roomId, "Login started, but no auth URL was returned.");
            return;
          }

          await sendTextMessage(options.client, roomId, `Open this URL to sign in: ${authUrl}`);
        } catch (error) {
          await sendTextMessage(options.client, roomId, `Failed to start login: ${String(error)}`);
          LogService.warn("matrix-runner", `Failed to start chatgpt login flow: ${String(error)}`);
        }

        return;
      }
    }

    if (options.codexAppServer && body) {
      try {
        options.codexAppServer.send({
          type: "matrix.room.message",
          roomId,
          sender,
          body,
          originServerTs: rawEvent["origin_server_ts"]
        });
      } catch (error) {
        LogService.warn("matrix-runner", `Failed to forward Matrix message to Codex: ${String(error)}`);
      }
    }
  };
}