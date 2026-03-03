/**
 * @fileoverview Matrix channel implementation for Slimebot.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
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

      const content = rawEvent["content"] as
        | {
            body?: string;
            msgtype?: string;
            url?: string;
            file?: { url?: string };
            info?: { mimetype?: string };
          }
        | undefined;
      if (!content) {
        return;
      }

      const body = await this.buildInboundBody(content);
      if (!body) {
        return;
      }

      const command = content.msgtype === "m.text" ? parseMatrixCommand(body) : undefined;
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

  /**
   * Builds the inbound text payload forwarded to the controller.
   *
   * For attachment-capable events, this downloads media and appends an
   * `Attachment saved to:` line with the local file path so Codex can access it.
   */
  private async buildInboundBody(content: {
    body?: string;
    msgtype?: string;
    url?: string;
    file?: { url?: string };
    info?: { mimetype?: string };
  }): Promise<string> {
    const textBody = content.body?.trim() ?? "";
    const savedAttachmentPath = await this.downloadAttachment(content);
    if (!savedAttachmentPath) {
      return textBody;
    }

    const attachmentLine = `Attachment saved to: ${savedAttachmentPath}`;
    if (!textBody) {
      return attachmentLine;
    }

    return `${textBody}\n\n${attachmentLine}`;
  }

  /**
   * Extracts a Matrix media URL from unencrypted (`content.url`) or encrypted
   * (`content.file.url`) message content.
   */
  private extractAttachmentUrl(content: {
    url?: string;
    file?: { url?: string };
  }): string | undefined {
    if (typeof content.url === "string" && content.url.trim()) {
      return content.url.trim();
    }

    if (typeof content.file?.url === "string" && content.file.url.trim()) {
      return content.file.url.trim();
    }

    return undefined;
  }

  /**
   * Downloads a Matrix attachment to the local attachments directory and returns
   * the absolute file path for forwarding to Codex.
   */
  private async downloadAttachment(content: {
    body?: string;
    url?: string;
    file?: { url?: string };
    info?: { mimetype?: string };
  }): Promise<string | undefined> {
    const attachmentUrl = this.extractAttachmentUrl(content);
    if (!attachmentUrl) {
      return undefined;
    }

    try {
      let data: Buffer;
      let contentTypeFromDownload: string | null = null;

      if (attachmentUrl.startsWith("mxc://")) {
        const downloadResult = await this.matrixClient.downloadContent(attachmentUrl);
        data = downloadResult.data;
        contentTypeFromDownload = downloadResult.contentType;
      } else {
        const downloadUrl = this.toDownloadUrl(attachmentUrl);
        if (!downloadUrl) {
          LogService.warn("matrix-runner", `Unsupported attachment URL, skipping download: ${attachmentUrl}`);
          return undefined;
        }

        const response = await fetch(downloadUrl, {
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`
          }
        });

        if (!response.ok) {
          LogService.warn(
            "matrix-runner",
            `Failed to download attachment (status=${String(response.status)}): ${downloadUrl}`
          );
          return undefined;
        }

        data = Buffer.from(await response.arrayBuffer());
        contentTypeFromDownload = response.headers.get("content-type");
      }

      const attachmentsDirectory = await this.getAttachmentsDirectory();
      const fileName = this.buildAttachmentFileName(
        content.body,
        content.info?.mimetype,
        contentTypeFromDownload
      );
      const absolutePath = join(attachmentsDirectory, fileName);
      await writeFile(absolutePath, data);
      return absolutePath;
    } catch (error) {
      LogService.warn("matrix-runner", `Attachment download failed: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Converts Matrix media references into HTTP(S) download URLs.
   */
  private toDownloadUrl(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    const mxcMatch = /^mxc:\/\/([^/]+)\/(.+)$/.exec(trimmed);
    if (!mxcMatch) {
      return undefined;
    }

    const serverName = encodeURIComponent(mxcMatch[1]);
    const mediaId = mxcMatch[2]
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    return `${this.config.homeserverUrl}/_matrix/media/v3/download/${serverName}/${mediaId}`;
  }

  /**
   * Resolves the attachments directory, preferring the Docker workspace mount.
   */
  private async getAttachmentsDirectory(): Promise<string> {
    const dockerWorkspacePath = "/var/lib/slimebot/workspace";
    const fallbackWorkspacePath = resolve(process.cwd(), "workspace");
    const workspacePath = (await this.pathExists(dockerWorkspacePath)) ? dockerWorkspacePath : fallbackWorkspacePath;
    const attachmentsPath = join(workspacePath, "attachments");
    await mkdir(attachmentsPath, { recursive: true });
    return attachmentsPath;
  }

  /**
   * Checks whether a filesystem path exists.
   */
  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Builds a stable attachment file name using message metadata and MIME type.
   */
  private buildAttachmentFileName(
    body: string | undefined,
    declaredMimeType: string | undefined,
    responseMimeType: string | null
  ): string {
    const requestedName = (body ?? "").trim();
    const safeBase = requestedName
      .replaceAll(/[^a-zA-Z0-9._-]/g, "_")
      .replaceAll(/^_+|_+$/g, "")
      .slice(0, 80);

    const extension = this.guessFileExtension(requestedName, declaredMimeType ?? responseMimeType ?? undefined);
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).slice(2, 8);
    const baseName = safeBase || "attachment";
    return `${timestamp}-${randomSuffix}-${baseName}${extension}`;
  }

  /**
   * Chooses a file extension from filename or MIME type hints.
   */
  private guessFileExtension(fileName: string, mimeType?: string): string {
    const existingExtension = extname(fileName);
    if (existingExtension) {
      return existingExtension;
    }

    const normalizedMime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
    switch (normalizedMime) {
      case "image/jpeg":
        return ".jpg";
      case "image/png":
        return ".png";
      case "image/gif":
        return ".gif";
      case "image/webp":
        return ".webp";
      case "application/pdf":
        return ".pdf";
      case "text/plain":
        return ".txt";
      case "application/json":
        return ".json";
      default:
        return "";
    }
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
