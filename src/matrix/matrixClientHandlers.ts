import { LogService, MatrixClient } from "matrix-bot-sdk";
import { CodexAppServerProcess } from "../codex/codexAppServerProcess.js";

type MatrixRoomInviteHandlerOptions = {
  client: MatrixClient;
  allowedInviteSender?: string;
};

type MatrixRoomMessageHandlerOptions = {
  botUserId?: string;
  codexAppServer?: CodexAppServerProcess;
};

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

    console.log(`[room.message] room=${roomId} sender=${sender} body=${content.body ?? ""}`);

    if (options.codexAppServer && content.body) {
      try {
        options.codexAppServer.send({
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
  };
}