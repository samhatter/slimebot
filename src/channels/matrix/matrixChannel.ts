/**
 * @fileoverview Matrix channel implementation for Slimebot.
 */

import { LogService, MatrixClient } from "matrix-bot-sdk";
import type { MatrixConfig } from "./config.js";
import {
  Channel,
  ChannelMessage,
  type ChannelApprovalRequest,
  ChannelOutboundMessage,
  type ChannelThreadStatusView,
  type ChannelToolActivityCompleted,
  type ChannelToolActivityStarted
} from "../channel.js";
import {
  formatApprovalRequest,
  formatCompactionCompleted,
  formatHelp,
  formatJsonResponse,
  formatMarkdownResponse,
  formatModelList,
  formatThreadList,
  formatThreadStatus,
  formatToolActivityCompleted,
  formatToolActivityStarted
} from "./matrixFormatting.js";
import { parseMatrixCommand } from "./matrixCommands.js";

/**
 * Matrix-backed channel that maps high-level controller responses to Matrix messages.
 */
export class MatrixChannel extends Channel {
  private readonly matrixClient: MatrixClient;
  private readonly processStartMs = Date.now();
  private static readonly maxRateLimitRetries = 8;
  private static readonly typingTimeoutMs = 30_000;
  private static readonly typingHeartbeatMs = 20_000;
  private static readonly typingResetDelayMs = 500;
  private readonly activeTurnCountByRoomId = new Map<string, number>();
  private readonly typingHeartbeatByRoomId = new Map<string, NodeJS.Timeout>();
  private readonly typingResetTimeoutByRoomId = new Map<string, NodeJS.Timeout>();

  public constructor(private readonly config: MatrixConfig) {
    super();
    this.matrixClient = new MatrixClient(config.homeserverUrl, config.accessToken);
  }

  /** Starts Matrix client sync and registers message/invite handlers. */
  public async start(): Promise<void> {
    this.registerEventHandlers();
    await this.matrixClient.start();
    LogService.info("matrix-runner", "Matrix channel started");
  }

  public async sendSystemMessage(roomId: string, body: string): Promise<void> {
    await this.sendMarkdownText(roomId, body);
  }

  /** Sends a direct Codex assistant reply. */
  public async sendCodexReply(roomId: string, body: string): Promise<void> {
    await this.sendMarkdownText(roomId, body);
  }

  public async sendHelp(roomId: string, lines: string[]): Promise<void> {
    const formattedHelp = formatHelp(lines);
    await this.sendHtmlText(roomId, formattedHelp.body, formattedHelp.formattedBody);
  }

  public async sendThreadList(roomId: string, result: unknown, archived: boolean): Promise<void> {
    const formattedThreadList = formatThreadList(result, archived);
    await this.sendHtmlText(roomId, formattedThreadList.body, formattedThreadList.formattedBody);
  }

  public async sendThreadStatus(roomId: string, input: ChannelThreadStatusView): Promise<void> {
    const formattedStatus = formatThreadStatus(input);
    await this.sendHtmlText(roomId, formattedStatus.body, formattedStatus.formattedBody);
  }

  public async sendModelList(roomId: string, result: unknown): Promise<void> {
    const formattedModelList = formatModelList(result);
    await this.sendHtmlText(roomId, formattedModelList.body, formattedModelList.formattedBody);
  }

  public async sendJsonResponse(roomId: string, title: string, value: unknown): Promise<void> {
    const response = formatJsonResponse(title, value);
    await this.sendHtmlText(roomId, response.body, response.formattedBody);
  }

  public async sendApprovalRequest(roomId: string, request: ChannelApprovalRequest): Promise<void> {
    const formattedApproval = formatApprovalRequest(request);
    await this.sendHtmlText(roomId, formattedApproval.body, formattedApproval.formattedBody);
  }

  public async sendToolActivityStarted(roomId: string, activity: ChannelToolActivityStarted): Promise<void> {
    const formattedToolStart = formatToolActivityStarted(activity);
    await this.sendHtmlText(roomId, formattedToolStart.body, formattedToolStart.formattedBody);
  }

  public async sendToolActivityCompleted(roomId: string, activity: ChannelToolActivityCompleted): Promise<void> {
    const formattedToolCompletion = formatToolActivityCompleted(activity);
    await this.sendHtmlText(roomId, formattedToolCompletion.body, formattedToolCompletion.formattedBody);
  }

  public async sendCompactionCompleted(roomId: string, threadId: string, turnId?: string): Promise<void> {
    const formattedCompaction = formatCompactionCompleted(threadId, turnId);
    await this.sendHtmlText(roomId, formattedCompaction.body, formattedCompaction.formattedBody);
  }

  public async indicateTurnStarted(roomId: string): Promise<void> {
    const currentCount = this.activeTurnCountByRoomId.get(roomId) ?? 0;
    const nextCount = currentCount + 1;
    this.activeTurnCountByRoomId.set(roomId, nextCount);

    if (currentCount > 0) {
      return;
    }

    try {
      await this.matrixClient.setTyping(roomId, true, MatrixChannel.typingTimeoutMs);
    } catch (error) {
      LogService.warn("matrix-runner", `Failed to set typing=true room=${roomId}: ${String(error)}`);
    }

    const heartbeat = setInterval(() => {
      void this.matrixClient
        .setTyping(roomId, true, MatrixChannel.typingTimeoutMs)
        .catch((error: unknown) => {
          LogService.warn("matrix-runner", `Failed typing heartbeat room=${roomId}: ${String(error)}`);
        });
    }, MatrixChannel.typingHeartbeatMs);

    this.typingHeartbeatByRoomId.set(roomId, heartbeat);
  }

  public async indicateTurnEnded(roomId: string): Promise<void> {
    const currentCount = this.activeTurnCountByRoomId.get(roomId) ?? 0;
    if (currentCount <= 0) {
      return;
    }

    const nextCount = currentCount - 1;
    if (nextCount > 0) {
      this.activeTurnCountByRoomId.set(roomId, nextCount);
      return;
    }

    this.activeTurnCountByRoomId.delete(roomId);

    const heartbeat = this.typingHeartbeatByRoomId.get(roomId);
    if (heartbeat) {
      clearInterval(heartbeat);
      this.typingHeartbeatByRoomId.delete(roomId);
    }

    this.clearPendingTypingReset(roomId);

    try {
      await this.matrixClient.setTyping(roomId, false);
    } catch (error) {
      LogService.warn("matrix-runner", `Failed to set typing=false room=${roomId}: ${String(error)}`);
    }
  }

  /** Sends an unformatted Matrix text message. */
  private async sendPlainText(roomId: string, body: string): Promise<void> {
    await this.sendMessage(roomId, "m.text", new ChannelOutboundMessage({ body }));
  }

  /** Sends a Matrix message with markdown rendered to HTML while preserving plain body. */
  private async sendMarkdownText(roomId: string, body: string): Promise<void> {
    const rendered = formatMarkdownResponse(body);
    await this.sendMessage(
      roomId,
      "m.text",
      new ChannelOutboundMessage({
        body: rendered.body,
        formattedBody: rendered.formattedBody,
        format: rendered.formattedBody ? "org.matrix.custom.html" : undefined
      })
    );
  }

  /** Sends a Matrix rich-text message with optional HTML body. */
  private async sendHtmlText(roomId: string, body: string, formattedBody?: string): Promise<void> {
    await this.sendMessage(
      roomId,
      "m.text",
      new ChannelOutboundMessage({
        body,
        formattedBody: formattedBody?.trim() ? formattedBody : undefined,
        format: "org.matrix.custom.html"
      })
    );
  }

  /** Registers inbound Matrix room event handlers. */
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
      const command = parseMatrixCommand(body);
      LogService.info("matrix-runner", `[room.message] room=${roomId} sender=${sender} body=${body}`);
      this.emitMessage(new ChannelMessage({
        roomId,
        sender,
        body,
        originServerTs: typeof originServerTs === "number" ? originServerTs : undefined,
        command
      }));
    });
  }

  /** Sends a Matrix message payload with msgtype and optional rich formatting. */
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

  /**
   * Sends a Matrix message with retries when homeserver rate limits are returned.
   */
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
        this.resetTypingIfTurnActive(roomId);
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

  /** Resets typing (false -> true) after sends while a turn is still active. */
  private resetTypingIfTurnActive(roomId: string): void {
    this.clearPendingTypingReset(roomId);

    if ((this.activeTurnCountByRoomId.get(roomId) ?? 0) <= 0) {
      return;
    }

    void this.matrixClient.setTyping(roomId, false).catch((error: unknown) => {
      LogService.warn("matrix-runner", `Failed typing reset(false) room=${roomId}: ${String(error)}`);
    });

    const timeout = setTimeout(() => {
      if ((this.activeTurnCountByRoomId.get(roomId) ?? 0) <= 0) {
        return;
      }

      void this.matrixClient.setTyping(roomId, true, MatrixChannel.typingTimeoutMs).catch((error: unknown) => {
        LogService.warn("matrix-runner", `Failed typing reset(true) room=${roomId}: ${String(error)}`);
      });
    }, MatrixChannel.typingResetDelayMs);

    this.typingResetTimeoutByRoomId.set(roomId, timeout);
  }

  private clearPendingTypingReset(roomId: string): void {
    const timeout = this.typingResetTimeoutByRoomId.get(roomId);
    if (!timeout) {
      return;
    }

    clearTimeout(timeout);
    this.typingResetTimeoutByRoomId.delete(roomId);
  }

  /** Extracts retry delay from Matrix M_LIMIT_EXCEEDED errors, if present. */
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

  /** Sleeps for a duration to implement retry backoff. */
  private async sleep(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
}
