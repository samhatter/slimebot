import { LogService, MatrixClient } from "matrix-bot-sdk";
import type { MatrixConfig } from "./appConfig.js";
import { CodexAppServerProcess } from "./codexAppServerProcess.js";
import { type ControllerCommand, parseControllerCommand } from "./controllerCommands.js";

type MatrixEventHandlerDependencies = {
  matrixClient: MatrixClient;
  matrixConfig: MatrixConfig;
  codexAppServer?: CodexAppServerProcess;
  handleCommand: (roomId: string, command: ControllerCommand) => Promise<void>;
};

export function registerMatrixEventHandlers(dependencies: MatrixEventHandlerDependencies): void {
  dependencies.matrixClient.on("room.invite", async (roomId: string, event: unknown): Promise<void> => {
    const rawEvent = event as Record<string, unknown>;
    const sender = rawEvent["sender"] as string | undefined;
    if (!sender) {
      LogService.info("matrix-runner", `[room.invite] ignored room=${roomId} sender=unknown`);
      return;
    }

    if (dependencies.matrixConfig.allowedInviteSender && sender !== dependencies.matrixConfig.allowedInviteSender) {
      LogService.info(
        "matrix-runner",
        `[room.invite] ignored room=${roomId} sender=${sender} reason=sender_not_allowed allowed=${dependencies.matrixConfig.allowedInviteSender}`
      );
      return;
    }

    try {
      await dependencies.matrixClient.joinRoom(roomId);
      LogService.info("matrix-runner", `[room.invite] joined room=${roomId} sender=${sender}`);
    } catch (error) {
      LogService.warn("matrix-runner", `Failed to join invited room ${roomId}: ${String(error)}`);
    }
  });

  dependencies.matrixClient.on("room.message", async (roomId: string, event: unknown): Promise<void> => {
    const rawEvent = event as Record<string, unknown>;
    const sender = rawEvent["sender"] as string | undefined;
    if (!sender || sender === dependencies.matrixConfig.botUserId) {
      return;
    }

    const content = rawEvent["content"] as { body?: string; msgtype?: string } | undefined;
    if (!content || content.msgtype !== "m.text") {
      return;
    }

    const body = content.body ?? "";
    LogService.info("matrix-runner", `[room.message] room=${roomId} sender=${sender} body=${body}`);

    const command = parseControllerCommand(body);
    if (command) {
      await dependencies.handleCommand(roomId, command);
      return;
    }

    if (!dependencies.codexAppServer || !body) {
      return;
    }

    try {
      dependencies.codexAppServer.send({
        type: "matrix.room.message",
        roomId,
        sender,
        body,
        originServerTs: rawEvent["origin_server_ts"]
      });
    } catch (error) {
      LogService.warn("matrix-runner", `Failed to forward Matrix message to Codex: ${String(error)}`);
    }
  });
}