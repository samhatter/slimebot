import { LogService, MatrixClient } from "matrix-bot-sdk";
import type { MatrixConfig } from "./config.js";
import { Channel, ChannelMessage, type ChannelOutboundMessage } from "../channel.js";

export class MatrixChannel extends Channel {
  private readonly matrixClient: MatrixClient;
  private readonly processStartMs = Date.now();

  public constructor(private readonly config: MatrixConfig) {
    super();
    this.matrixClient = new MatrixClient(config.homeserverUrl, config.accessToken);
  }

  public async start(): Promise<void> {
    this.registerEventHandlers();
    await this.matrixClient.start();
    LogService.info("matrix-runner", "Matrix channel started");
  }

  public async sendTextMessage(roomId: string, message: ChannelOutboundMessage): Promise<void> {
    const payload: {
      msgtype: "m.text";
      body: string;
    } = {
      msgtype: "m.text",
      body: message.body
    };

    await this.matrixClient.sendMessage(roomId, payload);
  }

  private registerEventHandlers(): void {
    this.matrixClient.on("room.invite", async (roomId: string, event: unknown): Promise<void> => {
      const rawEvent = event as Record<string, unknown>;
      const sender = rawEvent["sender"] as string | undefined;
      if (!sender) {
        LogService.info("matrix-runner", `[room.invite] ignored room=${roomId} sender=unknown`);
        return;
      }

      if (this.config.allowedInviteSender && sender !== this.config.allowedInviteSender) {
        LogService.info(
          "matrix-runner",
          `[room.invite] ignored room=${roomId} sender=${sender} reason=sender_not_allowed allowed=${this.config.allowedInviteSender}`
        );
        return;
      }

      try {
        await this.matrixClient.joinRoom(roomId);
        LogService.info("matrix-runner", `[room.invite] joined room=${roomId} sender=${sender}`);
      } catch (error) {
        LogService.warn("matrix-runner", `Failed to join invited room ${roomId}: ${String(error)}`);
      }
    });

    this.matrixClient.on("room.message", async (roomId: string, event: unknown): Promise<void> => {
      const rawEvent = event as Record<string, unknown>;
      const originServerTs = rawEvent["origin_server_ts"];
      if (typeof originServerTs === "number" && originServerTs < this.processStartMs) {
        return;
      }

      const sender = rawEvent["sender"] as string | undefined;
      if (!sender || sender === this.config.botUserId) {
        return;
      }

      const content = rawEvent["content"] as { body?: string; msgtype?: string } | undefined;
      if (!content || content.msgtype !== "m.text") {
        return;
      }

      const body = content.body ?? "";
      LogService.info("matrix-runner", `[room.message] room=${roomId} sender=${sender} body=${body}`);
      this.emitMessage(new ChannelMessage({
        roomId,
        sender,
        body,
        originServerTs: typeof originServerTs === "number" ? originServerTs : undefined
      }));
    });
  }
}
