import { LogService, MatrixClient } from "matrix-bot-sdk";
import type { MatrixConfig } from "./config.js";
import { Channel, ChannelMessage, type ChannelOutboundMessage } from "../channel.js";

export class MatrixChannel extends Channel {
  private readonly matrixClient: MatrixClient;
  private readonly processStartMs = Date.now();
  private static readonly maxRateLimitRetries = 8;

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
    await this.sendMessage(roomId, "m.text", message);
  }

  public async sendNoticeMessage(roomId: string, message: ChannelOutboundMessage): Promise<void> {
    await this.sendMessage(roomId, "m.notice", message);
  }

  public async sendRichTextMessage(roomId: string, message: ChannelOutboundMessage): Promise<void> {
    await this.sendMessage(roomId, "m.text", message);
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

  private async sendMessage(
    roomId: string,
    msgtype: "m.text" | "m.notice",
    message: ChannelOutboundMessage
  ): Promise<void> {
    const payload: {
      msgtype: "m.text" | "m.notice";
      body: string;
      format?: "org.matrix.custom.html";
      formatted_body?: string;
    } = {
      msgtype,
      body: message.body
    };

    if (typeof message.formattedBody === "string" && message.formattedBody.trim()) {
      payload.format = message.format === "org.matrix.custom.html" ? message.format : "org.matrix.custom.html";
      payload.formatted_body = message.formattedBody;
    }

    await this.sendMessageWithRateLimitRetry(roomId, payload);
  }

  private async sendMessageWithRateLimitRetry(
    roomId: string,
    payload: {
      msgtype: "m.text" | "m.notice";
      body: string;
      format?: "org.matrix.custom.html";
      formatted_body?: string;
    }
  ): Promise<void> {
    for (let attempt = 0; attempt <= MatrixChannel.maxRateLimitRetries; attempt += 1) {
      try {
        await this.matrixClient.sendMessage(roomId, payload);
        return;
      } catch (error) {
        const retryAfterMs = this.getMatrixRetryAfterMs(error);
        if (retryAfterMs === undefined) {
          throw error;
        }

        if (attempt >= MatrixChannel.maxRateLimitRetries) {
          LogService.warn(
            "matrix-runner",
            `Dropping outbound message after ${String(MatrixChannel.maxRateLimitRetries + 1)} rate-limited attempts room=${roomId}`
          );
          return;
        }

        const jitterMs = Math.floor(Math.random() * 250);
        const waitMs = Math.max(250, retryAfterMs) + jitterMs;
        LogService.warn(
          "matrix-runner",
          `Rate limited when sending to room=${roomId}; retrying in ${String(waitMs)}ms (attempt ${String(attempt + 1)}/${String(MatrixChannel.maxRateLimitRetries + 1)})`
        );
        await this.sleep(waitMs);
      }
    }
  }

  private getMatrixRetryAfterMs(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) {
      return undefined;
    }

    const errorRecord = error as Record<string, unknown>;
    const errcode = typeof errorRecord["errcode"] === "string"
      ? errorRecord["errcode"]
      : typeof (errorRecord["body"] as Record<string, unknown> | undefined)?.["errcode"] === "string"
        ? ((errorRecord["body"] as Record<string, unknown>)["errcode"] as string)
        : undefined;

    if (errcode !== "M_LIMIT_EXCEEDED") {
      return undefined;
    }

    const retryAfterMsFromTopLevel = errorRecord["retryAfterMs"];
    if (typeof retryAfterMsFromTopLevel === "number" && Number.isFinite(retryAfterMsFromTopLevel)) {
      return retryAfterMsFromTopLevel;
    }

    const body = errorRecord["body"] as Record<string, unknown> | undefined;
    const retryAfterMsFromBody = body?.["retry_after_ms"];
    if (typeof retryAfterMsFromBody === "number" && Number.isFinite(retryAfterMsFromBody)) {
      return retryAfterMsFromBody;
    }

    return 1000;
  }

  private async sleep(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
}
