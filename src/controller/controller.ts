import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ChannelOutboundMessage,
  type Channel
} from "../channels/channel.js";
import { createChannel } from "../channels/index.js";
import type { AppConfig } from "../config/config.js";
import { CodexAppServerProcess } from "../codexProcess/codexAppServerProcess.js";
import {
  asRecord,
  getAuthUrlFromLoginResult,
  type ControllerCommand,
  parseControllerCommand
} from "./commands.js";

type PendingApprovalRequest = {
  requestId: number | string;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
};

type PendingToolActivity = {
  threadId: string;
  turnId?: string;
  itemId: string;
  itemType: string;
  label: string;
  startedAtMs: number;
};

export class BotController {
  private readonly channel: Channel;
  private readonly codexAppServer?: CodexAppServerProcess;
  private readonly routingPersistencePath: string;
  private readonly roomThreadRoutes = new Map<string, string>();
  private readonly inFlightTurnByThreadId = new Map<string, string>();
  private readonly pendingCompactionByThreadId = new Set<string>();
  private readonly pendingInterruptByThreadId = new Map<string, string>();
  private readonly pendingToolActivityByKey = new Map<string, PendingToolActivity>();
  private readonly pendingApprovalByRoomId = new Map<string, PendingApprovalRequest>();
  private readonly pendingApprovalRoomByRequestId = new Map<string, string>();
  private loginRoomId?: string;
  private pendingLoginRedirectUri?: string;

  public constructor(appConfig: AppConfig) {
    this.channel = createChannel(appConfig.channel);
    this.routingPersistencePath = resolve(appConfig.controller.routingPersistencePath);
    this.loadRoomThreadRoutes();

    if (appConfig.codex.command) {
      this.codexAppServer = new CodexAppServerProcess(appConfig.codex.command, appConfig.codex.args);
    }
  }

  public async start(): Promise<void> {
    this.registerChannelEventHandlers();

    if (this.codexAppServer) {
      this.registerCodexEventHandlers();
    }

    this.registerShutdownHandlers();

    this.codexAppServer?.start();
    await this.initializeCodexAppServer();
    await this.restoreRoomThreadRoutes();

    await this.channel.start();
    this.logInfo("Bot runner started");
  }

  private registerShutdownHandlers(): void {
    const shutdown = (): void => {
      this.codexAppServer?.stop("SIGTERM");
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  private registerChannelEventHandlers(): void {
    this.channel.onMessage(async ({ roomId, sender, body, originServerTs }) => {
      const command = parseControllerCommand(body);
      if (command) {
        await this.handleCommand(roomId, command);
        return;
      }

      if (!this.codexAppServer || !body) {
        return;
      }

      const threadId = this.roomThreadRoutes.get(roomId);
      if (!threadId) {
        await this.sendTextMessage(roomId, "No Codex thread is mapped to this room yet. Run !new to create one.");
        return;
      }

      await this.sendUserMessageToThread(roomId, threadId, body);
    });
  }

  private registerCodexEventHandlers(): void {
    if (!this.codexAppServer) {
      return;
    }

    this.codexAppServer.on("start", (pid: number) => {
      this.logInfo(`Codex app server started pid=${pid}`);
    });

    this.codexAppServer.on("stdout", (line: string) => {
      this.logInfo(`[codex.stdout] ${line}`);
    });

    this.codexAppServer.on("stderr", (line: string) => {
      this.logWarn(`[codex.stderr] ${line}`);
    });

    this.codexAppServer.on("error", (error: Error) => {
      this.logError(`Codex app server error: ${String(error)}`);
    });

    this.codexAppServer.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.logWarn(`Codex app server exited code=${String(code)} signal=${String(signal)}`);
    });

    this.codexAppServer.on("message", async (message: unknown) => {
      const replyMessage = this.parseCodexReplyMessage(message);
      if (!replyMessage) {
        return;
      }

      try {
        await this.sendTextMessage(replyMessage.roomId, replyMessage.body);
      } catch (error) {
        this.logWarn(`Failed to send Codex reply to room ${replyMessage.roomId}: ${String(error)}`);
      }
    });

    this.codexAppServer.on("notification:account/login/completed", async (params: unknown) => {
      const roomId = this.loginRoomId;
      if (!roomId) {
        return;
      }

      const record = asRecord(params);
      const success = record?.["success"];
      const error = record?.["error"];

      if (success === true) {
        await this.sendTextMessage(roomId, "Login completed successfully.");
      } else {
        const errorText = typeof error === "string" && error ? error : "unknown error";
        await this.sendTextMessage(roomId, `Login failed: ${errorText}`);
      }

      this.pendingLoginRedirectUri = undefined;
      this.loginRoomId = undefined;
    });

    this.codexAppServer.on("notification:turn/started", (params: unknown) => {
      const record = asRecord(params);
      const turn = asRecord(record?.["turn"]);
      const threadId = this.readStringFromAny(record?.["threadId"], turn?.["threadId"]);
      const turnId = this.readStringFromAny(record?.["turnId"], turn?.["id"]);

      if (!threadId || !turnId) {
        return;
      }

      this.inFlightTurnByThreadId.set(threadId, turnId);
    });

    this.codexAppServer.on("notification:turn/completed", async (params: unknown) => {
      const record = asRecord(params);
      const turn = asRecord(record?.["turn"]);
      const threadId = this.readStringFromAny(record?.["threadId"], turn?.["threadId"]);
      const turnId = this.readStringFromAny(record?.["turnId"], turn?.["id"]);

      if (!threadId) {
        return;
      }

      const pendingInterruptTurnId = this.pendingInterruptByThreadId.get(threadId);
      if (pendingInterruptTurnId && (!turnId || pendingInterruptTurnId === turnId)) {
        this.pendingInterruptByThreadId.delete(threadId);

        const roomId = this.getRoomIdByThreadId(threadId);
        if (roomId) {
          await this.sendTextMessage(
            roomId,
            turnId
              ? `Interrupt completed for turn ${turnId} on thread ${threadId}.`
              : `Interrupt completed for thread ${threadId}.`
          );
        }
      }

      const currentTurnId = this.inFlightTurnByThreadId.get(threadId);
      if (!currentTurnId) {
        return;
      }

      if (!turnId || currentTurnId === turnId) {
        this.inFlightTurnByThreadId.delete(threadId);
      }

      this.clearPendingToolActivity(threadId, turnId);
    });

    this.codexAppServer.on("notification:item/started", async (params: unknown) => {
      const record = asRecord(params);
      const item = asRecord(record?.["item"]);
      const threadId = this.readStringFromAny(record?.["threadId"]);
      const turnId = this.readStringFromAny(record?.["turnId"]);
      const itemId = this.readStringFromAny(item?.["id"]);
      const itemType = this.readStringFromAny(item?.["type"]);

      if (!threadId || !itemId || !itemType || !item) {
        return;
      }

      const toolDisplay = this.describeToolLikeItem(itemType, item);
      if (!toolDisplay) {
        return;
      }

      const toolSnapshot = this.extractToolEventSnapshot(item);
      const toolSnapshotJson = toolSnapshot ? this.toJsonSnippet(toolSnapshot, 1800) : undefined;

      const key = this.getToolActivityKey(threadId, itemId);
      if (this.pendingToolActivityByKey.has(key)) {
        return;
      }

      this.pendingToolActivityByKey.set(key, {
        threadId,
        turnId,
        itemId,
        itemType,
        label: toolDisplay,
        startedAtMs: Date.now()
      });

      const roomId = this.getRoomIdByThreadId(threadId);
      if (!roomId) {
        return;
      }

      await this.sendRichTextMessage(
        roomId,
        [
          `Tool started: ${toolDisplay}`,
          `threadId: ${threadId}`,
          toolSnapshotJson ? `toolCall:\n${toolSnapshotJson}` : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        [
          "<b>Tool started</b>",
          `<ul>`,
          `<li><b>tool:</b> ${this.escapeHtml(toolDisplay)}</li>`,
          `<li><b>threadId:</b> <code>${this.escapeHtml(threadId)}</code></li>`,
          `</ul>`,
          toolSnapshotJson
            ? `<p><b>tool call</b></p><pre><code>${this.escapeHtml(toolSnapshotJson)}</code></pre>`
            : ""
        ].join("")
      );
    });

    this.codexAppServer.on("notification:item/completed", async (params: unknown) => {
      const record = asRecord(params);
      const item = asRecord(record?.["item"]);
      const threadId = this.readStringFromAny(record?.["threadId"]);
      const turnId = this.readStringFromAny(record?.["turnId"]);
      const itemId = this.readStringFromAny(item?.["id"]);
      const itemType = this.readStringFromAny(item?.["type"]);

      if (!threadId || !itemId || !itemType) {
        return;
      }

      if (itemType.toLowerCase() === "contextcompaction" && this.pendingCompactionByThreadId.has(threadId)) {
        this.pendingCompactionByThreadId.delete(threadId);
        const roomIdForCompaction = this.getRoomIdByThreadId(threadId);
        if (roomIdForCompaction) {
          await this.sendRichTextMessage(
            roomIdForCompaction,
            turnId
              ? `Compaction completed for ${threadId} (turn ${turnId}).`
              : `Compaction completed for ${threadId}.`,
            [
              "<b>Compaction completed</b>",
              "<ul>",
              `<li><b>threadId:</b> <code>${this.escapeHtml(threadId)}</code></li>`,
              turnId ? `<li><b>turnId:</b> <code>${this.escapeHtml(turnId)}</code></li>` : "",
              "</ul>"
            ].join("")
          );
        }
      }

      const key = this.getToolActivityKey(threadId, itemId);
      const pendingToolActivity = this.pendingToolActivityByKey.get(key);
      if (!pendingToolActivity) {
        return;
      }

      this.pendingToolActivityByKey.delete(key);

      const roomId = this.getRoomIdByThreadId(threadId);
      if (!roomId) {
        return;
      }

      const elapsedMs = Math.max(0, Date.now() - pendingToolActivity.startedAtMs);
      const elapsedSeconds = (elapsedMs / 1000).toFixed(1);
      const itemError = this.readStringFromAny(asRecord(item?.["error"])?.["message"], item?.["error"]);
      const completionLabel = itemError ? "Tool failed" : "Tool completed";
      const completionSnapshot = item ? this.extractToolEventSnapshot(item) : undefined;
      const completionSnapshotJson = completionSnapshot ? this.toJsonSnippet(completionSnapshot, 1800) : undefined;

      await this.sendRichTextMessage(
        roomId,
        [
          `${completionLabel}: ${pendingToolActivity.label} (${elapsedSeconds}s)`,
          `threadId: ${threadId}`,
          turnId ? `turnId: ${turnId}` : undefined,
          itemError ? `error: ${itemError}` : undefined,
          completionSnapshotJson ? `toolResult:\n${completionSnapshotJson}` : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        [
          `<b>${this.escapeHtml(completionLabel)}</b>`,
          `<ul>`,
          `<li><b>tool:</b> ${this.escapeHtml(pendingToolActivity.label)}</li>`,
          `<li><b>duration:</b> ${this.escapeHtml(elapsedSeconds)}s</li>`,
          `<li><b>threadId:</b> <code>${this.escapeHtml(threadId)}</code></li>`,
          turnId ? `<li><b>turnId:</b> <code>${this.escapeHtml(turnId)}</code></li>` : "",
          itemError ? `<li><b>error:</b> ${this.escapeHtml(itemError)}</li>` : "",
          `</ul>`,
          completionSnapshotJson
            ? `<p><b>tool result</b></p><pre><code>${this.escapeHtml(completionSnapshotJson)}</code></pre>`
            : ""
        ].join("")
      );
    });

    this.codexAppServer.on("notification:serverRequest/resolved", (params: unknown) => {
      const record = asRecord(params);
      const requestId = this.readStringFromAny(record?.["requestId"]);
      if (!requestId) {
        return;
      }

      const roomId = this.pendingApprovalRoomByRequestId.get(requestId);
      if (!roomId) {
        return;
      }

      this.pendingApprovalRoomByRequestId.delete(requestId);
      this.pendingApprovalByRoomId.delete(roomId);
    });

    this.codexAppServer.on(
      "request:item/commandExecution/requestApproval",
      async (requestId: number | string, params: unknown) => {
        await this.handleApprovalRequest(requestId, "item/commandExecution/requestApproval", params);
      }
    );

    this.codexAppServer.on(
      "request:item/fileChange/requestApproval",
      async (requestId: number | string, params: unknown) => {
        await this.handleApprovalRequest(requestId, "item/fileChange/requestApproval", params);
      }
    );
  }

  private async sendUserMessageToThread(roomId: string, threadId: string, body: string): Promise<void> {
    if (!this.codexAppServer) {
      return;
    }

    const inFlightTurnId = this.inFlightTurnByThreadId.get(threadId);
    if (inFlightTurnId) {
      try {
        await this.codexAppServer.turnSteer({
          threadId,
          expectedTurnId: inFlightTurnId,
          input: [
            {
              type: "text",
              text: body
            }
          ]
        });
        return;
      } catch (error) {
        this.logWarn(`Failed to steer active turn ${inFlightTurnId} for thread ${threadId}: ${String(error)}`);
        this.inFlightTurnByThreadId.delete(threadId);
      }
    }

    try {
      const result = await this.codexAppServer.turnStart({
        threadId,
        input: [
          {
            type: "text",
            text: body
          }
        ]
      });

      const turnId = asRecord(asRecord(result)?.["turn"])?.["id"];
      if (typeof turnId === "string" && turnId) {
        this.inFlightTurnByThreadId.set(threadId, turnId);
      }
    } catch (error) {
      this.logWarn(`Failed to send message to Codex thread ${threadId}: ${String(error)}`);
      await this.sendTextMessage(roomId, `Failed to send message to Codex: ${String(error)}`);
    }
  }

  private async handleApprovalRequest(
    requestId: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    if (!this.codexAppServer) {
      return;
    }

    const record = asRecord(params);
    const threadId = this.readStringFromAny(record?.["threadId"]);
    const turnId = this.readStringFromAny(record?.["turnId"]);
    const itemId = this.readStringFromAny(record?.["itemId"]);

    if (!threadId || !turnId || !itemId) {
      this.codexAppServer.respondSuccess(requestId, { decision: "decline" });
      return;
    }

    const roomId = this.getRoomIdByThreadId(threadId);
    if (!roomId) {
      this.logWarn(`Approval request ${String(requestId)} for unmapped thread ${threadId}; auto-declining.`);
      this.codexAppServer.respondSuccess(requestId, { decision: "decline" });
      return;
    }

    const pendingApproval: PendingApprovalRequest = {
      requestId,
      method,
      threadId,
      turnId,
      itemId
    };

    this.pendingApprovalByRoomId.set(roomId, pendingApproval);
    this.pendingApprovalRoomByRequestId.set(String(requestId), roomId);

    const reason = this.readStringFromAny(record?.["reason"]);
    const approvalType = method === "item/fileChange/requestApproval" ? "file change" : "command";
    const commandPreview = Array.isArray(record?.["command"])
      ? (record?.["command"] as unknown[]).filter((part): part is string => typeof part === "string").join(" ")
      : "";

    const approvalLines = [
      `<b>Approval requested for ${this.escapeHtml(approvalType)}</b>`,
      `<ul>`,
      `<li><b>threadId:</b> <code>${this.escapeHtml(threadId)}</code></li>`,
      `<li><b>turnId:</b> <code>${this.escapeHtml(turnId)}</code></li>`,
      `<li><b>itemId:</b> <code>${this.escapeHtml(itemId)}</code></li>`,
      commandPreview ? `<li><b>command:</b> <code>${this.escapeHtml(commandPreview)}</code></li>` : undefined,
      reason ? `<li><b>reason:</b> ${this.escapeHtml(reason)}</li>` : undefined,
      `</ul>`,
      `<p>Reply with <code>!approve</code> (<code>!a</code>) to approve, or <code>!skip</code> (<code>!s</code>) to decline.</p>`
    ]
      .filter((line): line is string => typeof line === "string")
      .join("");

    await this.sendRichTextMessage(
      roomId,
      [
        `Approval requested for ${approvalType}.`,
        `threadId: ${threadId}`,
        `turnId: ${turnId}`,
        `itemId: ${itemId}`,
        commandPreview ? `command: ${commandPreview}` : undefined,
        reason ? `reason: ${reason}` : undefined,
        "Reply with !approve (!a) to approve, or !skip (!s) to decline."
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n"),
      approvalLines
    );
  }

  private parseCodexReplyMessage(message: unknown): { roomId: string; body: string } | undefined {
    const record = asRecord(message);
    if (!record) {
      return undefined;
    }

    const roomId = record["roomId"];
    const body = record["body"];

    if (typeof roomId !== "string" || typeof body !== "string") {
      const method = record["method"];
      if (method !== "item/completed") {
        return undefined;
      }

      const params = asRecord(record["params"]);
      const threadId = params?.["threadId"];
      const item = asRecord(params?.["item"]);
      const itemType = item?.["type"];
      const itemText = item?.["text"];

      if (typeof threadId !== "string" || itemType !== "agentMessage" || typeof itemText !== "string") {
        return undefined;
      }

      const mappedRoomId = this.getRoomIdByThreadId(threadId);
      if (!mappedRoomId || !itemText.trim()) {
        return undefined;
      }

      return {
        roomId: mappedRoomId,
        body: itemText
      };
    }

    return { roomId, body };
  }

  private getRoomIdByThreadId(threadId: string): string | undefined {
    for (const [roomId, mappedThreadId] of this.roomThreadRoutes.entries()) {
      if (mappedThreadId === threadId) {
        return roomId;
      }
    }

    return undefined;
  }

  private async handleCommand(roomId: string, command: ControllerCommand): Promise<void> {
    switch (command.name) {
      case "help":
        await this.handleHelpCommand(roomId);
        return;
      case "new":
        await this.handleNewCommand(roomId);
        return;
      case "resume":
        await this.handleResumeCommand(roomId, command);
        return;
      case "threads":
        await this.handleThreadsCommand(roomId, command);
        return;
      case "rollback":
        await this.handleRollbackCommand(roomId, command);
        return;
      case "compact":
        await this.handleCompactCommand(roomId, command);
        return;
      case "archive":
        await this.handleArchiveCommand(roomId, command);
        return;
      case "unarchive":
        await this.handleUnarchiveCommand(roomId, command);
        return;
      case "interrupt":
        await this.handleInterruptCommand(roomId, command);
        return;
      case "approve":
        await this.handleApprovalDecisionCommand(roomId, "accept");
        return;
      case "skip":
        await this.handleApprovalDecisionCommand(roomId, "decline");
        return;
      case "login":
        await this.handleLoginCommand(roomId);
        return;
      case "callback":
        await this.handleCallbackCommand(roomId, command);
        return;
      case "models":
        await this.handleModelsCommand(roomId);
        return;
      case "account":
        await this.handleAccountCommand(roomId);
        return;
      default:
        return;
    }
  }

  private async handleHelpCommand(roomId: string): Promise<void> {
    const lines = [
      "Available commands:",
      "- !help: Show this command list",
      "- !new: Create and map a new Codex thread for this room",
      "- !resume <threadId>: Resume a thread and map it to this room",
      "- !threads [archived]: List recent threads",
      "- !rollback [numTurns] [threadId]: Roll back turns (default 1)",
      "- !compact [threadId]: Trigger thread compaction",
      "- !archive [threadId]: Archive a thread",
      "- !unarchive [threadId]: Unarchive a thread",
      "- !interrupt [threadId]: Interrupt in-flight turn (!i)",
      "- !approve: Approve pending request in this room (!a)",
      "- !skip: Decline pending request in this room (!s)",
      "- !login: Start ChatGPT login flow",
      "- !callback <full-callback-url>: Complete login callback",
      "- !models: List available models",
      "- !account: Show account information"
    ];

    const formattedBody = [
      "<b>Available commands</b>",
      "<ul>",
      ...lines.slice(1).map((line) => {
        const [command, ...descriptionParts] = line.slice(2).split(":");
        const description = descriptionParts.join(":").trim();
        return `<li><code>${this.escapeHtml(command.trim())}</code>: ${this.escapeHtml(description)}</li>`;
      }),
      "</ul>"
    ].join("");

    await this.sendRichTextMessage(
      roomId,
      lines.join("\n"),
      formattedBody
    );
  }

  private async handleNewCommand(roomId: string): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    try {
      const result = await this.codexAppServer.threadStart({});
      const threadId = asRecord(asRecord(result)?.["thread"])?.["id"];
      if (!threadId) {
        await this.sendTextMessage(roomId, `Thread was created but no thread id was returned:\n${this.stringifyJson(result)}`);
        return;
      }

      if (typeof threadId !== "string") {
        await this.sendTextMessage(roomId, `Thread response had invalid thread.id:\n${this.stringifyJson(result)}`);
        return;
      }

      const previousThreadId = this.roomThreadRoutes.get(roomId);
      this.roomThreadRoutes.set(roomId, threadId);
      this.persistRoomThreadRoutes();

      await this.sendTextMessage(
        roomId,
        previousThreadId
          ? `Mapped room to new thread ${threadId} (replaced ${previousThreadId}).`
          : `Mapped room to new thread ${threadId}.`
      );
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to create a new thread: ${String(error)}`);
      this.logWarn(`Failed to create a new thread for room ${roomId}: ${String(error)}`);
    }
  }

  private async handleResumeCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = command.args[0]?.trim();
    if (!threadId) {
      await this.sendTextMessage(roomId, "Usage: !resume <threadId>");
      return;
    }

    try {
      const result = await this.codexAppServer.threadResume({ threadId });
      const resumedThreadId = asRecord(asRecord(result)?.["thread"])?.["id"];
      if (typeof resumedThreadId !== "string" || !resumedThreadId) {
        await this.sendTextMessage(roomId, `Thread resume response missing thread.id:\n${this.stringifyJson(result)}`);
        return;
      }

      const previousThreadId = this.roomThreadRoutes.get(roomId);
      this.roomThreadRoutes.set(roomId, resumedThreadId);
      this.persistRoomThreadRoutes();

      await this.sendTextMessage(
        roomId,
        previousThreadId
          ? `Resumed ${resumedThreadId} and remapped room (replaced ${previousThreadId}).`
          : `Resumed ${resumedThreadId} and mapped it to this room.`
      );
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to resume thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to resume thread ${threadId}: ${String(error)}`);
    }
  }

  private async handleThreadsCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const archivedArg = command.args[0]?.toLowerCase();
    const archived = archivedArg === "archived" || archivedArg === "true";

    try {
      const result = await this.codexAppServer.threadList({
        limit: 20,
        sortKey: "updated_at",
        archived
      });
      const formattedThreadList = this.formatThreadList(result, archived);
      await this.sendRichTextMessage(roomId, formattedThreadList.body, formattedThreadList.formattedBody);
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to list threads: ${String(error)}`);
      this.logWarn(`Failed to list threads: ${String(error)}`);
    }
  }

  private async handleRollbackCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const firstArg = command.args[0]?.trim();
    const maybeNumTurns = firstArg ? Number(firstArg) : Number.NaN;

    const numTurns = Number.isFinite(maybeNumTurns) && maybeNumTurns >= 1 ? Math.trunc(maybeNumTurns) : 1;
    const threadIdArg = Number.isFinite(maybeNumTurns) ? command.args[1] : command.args[0];
    const threadId = this.resolveThreadIdForCommand(roomId, threadIdArg?.trim(), "!rollback [numTurns] [threadId]");
    if (!threadId) {
      return;
    }

    try {
      const result = await this.codexAppServer.threadRollback({ threadId, numTurns });
      await this.sendTextMessage(roomId, `Rollback completed for ${threadId}.\n${this.stringifyJson(result)}`);
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to rollback thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to rollback thread ${threadId}: ${String(error)}`);
    }
  }

  private async handleCompactCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[0]?.trim(), "!compact [threadId]");
    if (!threadId) {
      return;
    }

    if (this.pendingCompactionByThreadId.has(threadId)) {
      await this.sendTextMessage(roomId, `Compaction is already in progress for ${threadId}.`);
      return;
    }

    this.pendingCompactionByThreadId.add(threadId);

    try {
      await this.codexAppServer.threadCompactStart({ threadId });
      await this.sendTextMessage(roomId, `Started compaction for ${threadId}.`);
    } catch (error) {
      this.pendingCompactionByThreadId.delete(threadId);
      await this.sendTextMessage(roomId, `Failed to compact thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to compact thread ${threadId}: ${String(error)}`);
    }
  }

  private async handleArchiveCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[0]?.trim(), "!archive [threadId]");
    if (!threadId) {
      return;
    }

    try {
      await this.codexAppServer.threadArchive({ threadId });
      await this.sendTextMessage(roomId, `Archived thread ${threadId}.`);
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to archive thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to archive thread ${threadId}: ${String(error)}`);
    }
  }

  private async handleUnarchiveCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[0]?.trim(), "!unarchive [threadId]");
    if (!threadId) {
      return;
    }

    try {
      const result = await this.codexAppServer.threadUnarchive({ threadId });
      await this.sendTextMessage(roomId, `Unarchived thread ${threadId}.\n${this.stringifyJson(result)}`);
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to unarchive thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to unarchive thread ${threadId}: ${String(error)}`);
    }
  }

  private async handleInterruptCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[0]?.trim(), "!interrupt [threadId]");
    if (!threadId) {
      return;
    }

    const turnId = this.inFlightTurnByThreadId.get(threadId);
    if (!turnId) {
      await this.sendTextMessage(roomId, `No in-flight turn found for thread ${threadId}.`);
      return;
    }

    const pendingInterruptTurnId = this.pendingInterruptByThreadId.get(threadId);
    if (pendingInterruptTurnId && pendingInterruptTurnId === turnId) {
      await this.sendTextMessage(roomId, `Interrupt is already in progress for turn ${turnId}.`);
      return;
    }

    this.pendingInterruptByThreadId.set(threadId, turnId);

    try {
      await this.codexAppServer.turnInterrupt({ threadId, turnId });
      await this.sendTextMessage(roomId, `Interrupt requested for turn ${turnId}. You'll be notified when it completes.`);
    } catch (error) {
      this.pendingInterruptByThreadId.delete(threadId);
      await this.sendTextMessage(roomId, `Failed to interrupt turn ${turnId}: ${String(error)}`);
      this.logWarn(`Failed to interrupt turn ${turnId} on thread ${threadId}: ${String(error)}`);
    }
  }

  private async handleApprovalDecisionCommand(roomId: string, decision: "accept" | "decline"): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const pendingApproval = this.pendingApprovalByRoomId.get(roomId);
    if (!pendingApproval) {
      await this.sendTextMessage(roomId, "No pending approval request in this room.");
      return;
    }

    const requestId = pendingApproval.requestId;
    if (pendingApproval.method === "item/commandExecution/requestApproval") {
      this.codexAppServer.respondSuccess(requestId, { decision });
    } else if (pendingApproval.method === "item/fileChange/requestApproval") {
      this.codexAppServer.respondSuccess(requestId, { decision });
    } else {
      this.codexAppServer.respondError(requestId, {
        code: -32601,
        message: `Unsupported approval request method: ${pendingApproval.method}`
      });
      this.pendingApprovalByRoomId.delete(roomId);
      this.pendingApprovalRoomByRequestId.delete(String(requestId));
      await this.sendTextMessage(roomId, "Pending approval request could not be handled.");
      return;
    }

    this.pendingApprovalByRoomId.delete(roomId);
    this.pendingApprovalRoomByRequestId.delete(String(requestId));

    await this.sendTextMessage(
      roomId,
      decision === "accept" ? "Approval sent to Codex." : "Decline sent to Codex."
    );
  }

  private async handleModelsCommand(roomId: string): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    try {
      const result = await this.codexAppServer.modelList({});
      const formattedModelList = this.formatModelList(result);
      await this.sendRichTextMessage(roomId, formattedModelList.body, formattedModelList.formattedBody);
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to list models: ${String(error)}`);
      this.logWarn(`Failed to list models: ${String(error)}`);
    }
  }

  private async handleAccountCommand(roomId: string): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    try {
      const result = await this.codexAppServer.accountRead({});
      const accountResponse = this.formatJsonResponse("Account response", result);
      await this.sendRichTextMessage(roomId, accountResponse.body, accountResponse.formattedBody);
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to read account: ${String(error)}`);
      this.logWarn(`Failed to read account: ${String(error)}`);
    }
  }

  private async handleLoginCommand(roomId: string): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    try {
      const loginResult = await this.codexAppServer.accountLoginStart({
        type: "chatgpt"
      });
      const authUrl = getAuthUrlFromLoginResult(loginResult);

      if (!authUrl) {
        await this.sendTextMessage(roomId, "Login started, but no auth URL was returned.");
        return;
      }

      this.loginRoomId = roomId;
      this.pendingLoginRedirectUri = this.getRedirectUriFromAuthUrl(authUrl);

      await this.sendTextMessage(
        roomId,
        `Open this URL to sign in: ${authUrl}\nAfter approving, paste the full callback URL here using: !callback <callback-url>`
      );
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to start login: ${String(error)}`);
      this.logWarn(`Failed to start chatgpt login flow: ${String(error)}`);
    }
  }

  private async handleCallbackCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const callbackInput = command.args[0]?.trim();
    if (!callbackInput) {
      await this.sendTextMessage(roomId, "Usage: !callback <full-callback-url>");
      return;
    }

    const callbackUrl = this.normalizeCallbackUrl(callbackInput);
    if (!callbackUrl) {
      await this.sendTextMessage(roomId, "Could not parse callback URL. Paste the full URL from your browser.");
      return;
    }

    try {
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort();
      }, 15_000);
      try {
        const response = await fetch(callbackUrl, {
          method: "GET",
          redirect: "follow",
          signal: abortController.signal
        });

        await this.sendTextMessage(
          roomId,
          `Callback accepted inside container (status ${response.status}). Waiting for login completion notification…`
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to trigger callback URL: ${String(error)}`);
      this.logWarn(`Failed to trigger callback URL: ${String(error)}`);
    }
  }

  private getRedirectUriFromAuthUrl(authUrl: string): string | undefined {
    try {
      const parsedAuthUrl = new URL(authUrl);
      const redirectUri = parsedAuthUrl.searchParams.get("redirect_uri");
      return redirectUri ?? undefined;
    } catch {
      return undefined;
    }
  }

  private normalizeCallbackUrl(input: string): string | undefined {
    const cleanedInput = input.replace(/^<|>$/gu, "");

    try {
      return new URL(cleanedInput).toString();
    } catch {
    }

    if (this.pendingLoginRedirectUri && cleanedInput.startsWith("/")) {
      try {
        return new URL(cleanedInput, this.pendingLoginRedirectUri).toString();
      } catch {
      }
    }

    return undefined;
  }

  private async initializeCodexAppServer(): Promise<void> {
    if (!this.codexAppServer) {
      return;
    }

    try {
      await this.codexAppServer.initialize({
        clientInfo: {
          name: "slimebot",
          title: "Slimebot",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      });
      this.logInfo("Codex app server initialized");
    } catch (error) {
      this.logWarn(`Failed to initialize Codex app server: ${String(error)}`);
    }
  }

  private async restoreRoomThreadRoutes(): Promise<void> {
    if (!this.codexAppServer || this.roomThreadRoutes.size === 0) {
      return;
    }

    for (const [roomId, threadId] of this.roomThreadRoutes.entries()) {
      try {
        await this.codexAppServer.threadResume({ threadId });
      } catch (error) {
        this.logWarn(
          `Failed to resume mapped thread for room ${roomId} threadId=${threadId}: ${String(error)}`
        );
      }
    }
  }

  private resolveThreadIdForCommand(roomId: string, threadIdArg: string | undefined, usage: string): string | undefined {
    const threadId = threadIdArg || this.roomThreadRoutes.get(roomId);
    if (threadId) {
      return threadId;
    }

    void this.sendTextMessage(roomId, `No mapped thread for this room. Usage: ${usage}`);
    return undefined;
  }

  private getToolActivityKey(threadId: string, itemId: string): string {
    return `${threadId}:${itemId}`;
  }

  private clearPendingToolActivity(threadId: string, turnId?: string): void {
    for (const [key, pendingToolActivity] of this.pendingToolActivityByKey.entries()) {
      if (pendingToolActivity.threadId !== threadId) {
        continue;
      }

      if (turnId && pendingToolActivity.turnId && pendingToolActivity.turnId !== turnId) {
        continue;
      }

      this.pendingToolActivityByKey.delete(key);
    }
  }

  private describeToolLikeItem(itemType: string, item: Record<string, unknown>): string | undefined {
    const normalizedType = itemType.toLowerCase();

    const ignoredTypes = new Set([
      "usermessage",
      "agentmessage",
      "contextcompaction"
    ]);
    if (ignoredTypes.has(normalizedType)) {
      return undefined;
    }

    if (normalizedType === "commandexecution") {
      const command = item["command"];
      if (Array.isArray(command)) {
        const commandParts = command.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
        if (commandParts.length > 0) {
          return `${itemType}: ${commandParts.join(" ")}`;
        }
      }
      return itemType;
    }

    if (normalizedType === "mcptoolcall") {
      const server = this.readStringFromAny(item["server"]);
      const tool = this.readStringFromAny(item["tool"]);
      if (server && tool) {
        return `${itemType} (${server}/${tool})`;
      }
      if (tool) {
        return `${itemType} (${tool})`;
      }
      return itemType;
    }

    if (normalizedType === "collabtoolcall") {
      const tool = this.readStringFromAny(item["tool"]);
      return tool ? `${itemType} (${tool})` : itemType;
    }

    if (normalizedType === "websearch") {
      const query = this.readStringFromAny(item["query"]);
      return query ? `${itemType}: ${query}` : itemType;
    }

    if (normalizedType === "imageview") {
      const path = this.readStringFromAny(item["path"]);
      return path ? `${itemType}: ${path}` : itemType;
    }

    if (normalizedType === "filechange") {
      const changes = item["changes"];
      if (Array.isArray(changes)) {
        return `${itemType} (${changes.length} change${changes.length === 1 ? "" : "s"})`;
      }
      return itemType;
    }

    const hasToolSignals = [
      "toolName",
      "tool_name",
      "recipient_name",
      "recipientName",
      "command",
      "filePath",
      "dirPath",
      "query",
      "url",
      "urls",
      "packageList",
      "method"
    ].some((field) => field in item);

    const typeLooksToolLike = [
      "tool",
      "command",
      "exec",
      "filechange",
      "applypatch",
      "search",
      "read",
      "write",
      "terminal",
      "mcp"
    ].some((token) => normalizedType.includes(token));

    if (!hasToolSignals && !typeLooksToolLike) {
      return undefined;
    }

    const toolName = this.readStringFromAny(item["toolName"], item["tool_name"], item["recipient_name"], item["recipientName"]);
    if (toolName) {
      return `${itemType} (${toolName})`;
    }

    const command = item["command"];
    if (typeof command === "string" && command.trim()) {
      return `${itemType}: ${command.trim()}`;
    }

    if (Array.isArray(command)) {
      const commandParts = command.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
      if (commandParts.length > 0) {
        return `${itemType}: ${commandParts.join(" ")}`;
      }
    }

    const method = this.readStringFromAny(item["method"]);
    if (method) {
      return `${itemType} (${method})`;
    }

    return itemType;
  }

  private formatThreadList(result: unknown, archived: boolean): { body: string; formattedBody?: string } {
    const record = asRecord(result);
    const data = record?.["data"];
    if (!Array.isArray(data) || data.length === 0) {
      const emptyMessage = archived ? "No archived threads found." : "No threads found.";
      return {
        body: emptyMessage,
        formattedBody: `<p>${this.escapeHtml(emptyMessage)}</p>`
      };
    }

    const entries = data
      .slice(0, 20)
      .map((item) => {
        const entry = asRecord(item);
        const threadId = this.readStringFromAny(entry?.["id"]) ?? "<unknown>";
        const name = this.readStringFromAny(entry?.["name"]);
        const preview = this.readStringFromAny(entry?.["preview"]);
        const updatedAt = this.readStringFromAny(entry?.["updatedAt"], entry?.["createdAt"]);
        const modelProvider = this.readStringFromAny(entry?.["modelProvider"]);
        const statusType = this.readStringFromAny(asRecord(entry?.["status"])?.["type"]);

        return {
          threadId,
          name,
          preview,
          updatedAt,
          modelProvider,
          statusType
        };
      });

    const lines = entries
      .map((entry, index) => {
        const { threadId, name, preview, updatedAt, modelProvider, statusType } = entry;

        return `${index + 1}. ${threadId} | ${name ?? "-"} | ${preview ?? "-"} | ${updatedAt ?? "-"} | ${modelProvider ?? "-"} | ${statusType ?? "-"}`;
      })
      .join("\n");

    const heading = `${archived ? "Archived" : "Active"} threads:`;
    const formattedBody = [
      `<b>${this.escapeHtml(archived ? "Archived" : "Active")} threads</b>`,
      "<table>",
      "<thead><tr><th>#</th><th>Thread ID</th><th>Name</th><th>Preview</th><th>Updated</th><th>Provider</th><th>Status</th></tr></thead>",
      "<tbody>",
      ...entries.map(
        ({ threadId, name, preview, updatedAt, modelProvider, statusType }, index) =>
          `<tr><td>${index + 1}</td><td><code>${this.escapeHtml(threadId)}</code></td><td>${this.escapeHtml(name ?? "-")}</td><td>${this.escapeHtml(preview ?? "-")}</td><td>${this.escapeHtml(updatedAt ?? "-")}</td><td>${this.escapeHtml(modelProvider ?? "-")}</td><td>${this.escapeHtml(statusType ?? "-")}</td></tr>`
      ),
      "</tbody>",
      "</table>"
    ].join("");

    return {
      body: `${heading}\n${lines}`,
      formattedBody
    };
  }

  private formatModelList(result: unknown): { body: string; formattedBody?: string } {
    const record = asRecord(result);
    const data = record?.["data"];
    if (!Array.isArray(data)) {
      return this.formatJsonResponse("Model response", result);
    }

    const entries = data
      .slice(0, 40)
      .map((item) => {
        const entry = asRecord(item);
        const modelId = this.readStringFromAny(entry?.["id"], entry?.["model"]);

        if (!modelId) {
          return undefined;
        }

        const displayName = this.readStringFromAny(entry?.["displayName"]) ?? "-";
        const defaultReasoningEffort = this.readStringFromAny(entry?.["defaultReasoningEffort"]) ?? "-";
        const upgrade = this.readStringFromAny(entry?.["upgrade"]) ?? "-";

        const inputModalitiesRaw = entry?.["inputModalities"];
        const inputModalities = Array.isArray(inputModalitiesRaw)
          ? inputModalitiesRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : ["text", "image"];

        const hidden = entry?.["hidden"] === true ? "yes" : "no";
        const isDefault = entry?.["isDefault"] === true ? "yes" : "no";

        return {
          modelId,
          displayName,
          defaultReasoningEffort,
          upgrade,
          inputModalities,
          hidden,
          isDefault
        };
      })
      .filter(
        (
          entry
        ): entry is {
          modelId: string;
          displayName: string;
          defaultReasoningEffort: string;
          upgrade: string;
          inputModalities: string[];
          hidden: string;
          isDefault: string;
        } => Boolean(entry)
      );

    if (entries.length === 0) {
      return this.formatJsonResponse("Model response", result);
    }

    const lines = [
      "Available models:",
      ...entries.map(
        (entry, index) =>
          `${index + 1}. ${entry.modelId} | ${entry.displayName} | ${entry.defaultReasoningEffort} | ${entry.inputModalities.join(", ")} | ${entry.isDefault} | ${entry.hidden}${entry.upgrade !== "-" ? ` | ${entry.upgrade}` : ""}`
      )
    ];

    const formattedBody = [
      "<b>Available models</b>",
      "<table>",
      "<thead><tr><th>#</th><th>Model</th><th>Name</th><th>Default Effort</th><th>Input Modalities</th><th>Default</th><th>Hidden</th><th>Upgrade</th></tr></thead>",
      "<tbody>",
      ...entries.map(
        (entry, index) =>
          `<tr><td>${index + 1}</td><td><code>${this.escapeHtml(entry.modelId)}</code></td><td>${this.escapeHtml(entry.displayName)}</td><td>${this.escapeHtml(entry.defaultReasoningEffort)}</td><td>${this.escapeHtml(entry.inputModalities.join(", "))}</td><td>${this.escapeHtml(entry.isDefault)}</td><td>${this.escapeHtml(entry.hidden)}</td><td>${entry.upgrade !== "-" ? `<code>${this.escapeHtml(entry.upgrade)}</code>` : "-"}</td></tr>`
      ),
      "</tbody>",
      "</table>"
    ].join("");

    return {
      body: lines.join("\n"),
      formattedBody
    };
  }

  private formatJsonResponse(title: string, value: unknown): { body: string; formattedBody?: string } {
    const json = this.toJsonSnippet(value, 7000);
    return {
      body: `${title}:\n${json}`,
      formattedBody: `<b>${this.escapeHtml(title)}</b><pre><code>${this.escapeHtml(json)}</code></pre>`
    };
  }

  private extractToolEventSnapshot(item: Record<string, unknown>): Record<string, unknown> | undefined {
    const snapshot: Record<string, unknown> = {};
    const preferredFields = [
      "id",
      "type",
      "status",
      "phase",
      "threadId",
      "turnId",
      "command",
      "cwd",
      "durationMs",
      "exitCode",
      "server",
      "tool",
      "arguments",
      "result",
      "review",
      "query",
      "url",
      "path",
      "changes",
      "commandActions",
      "aggregatedOutput",
      "error"
    ];

    for (const field of preferredFields) {
      const value = item[field];
      if (value !== undefined) {
        snapshot[field] = value;
      }
    }

    return Object.keys(snapshot).length > 0 ? snapshot : undefined;
  }

  private readStringFromAny(...values: Array<unknown>): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value) {
        return value;
      }

      if (typeof value === "number") {
        return String(value);
      }
    }

    return undefined;
  }

  private loadRoomThreadRoutes(): void {
    try {
      const rawState = readFileSync(this.routingPersistencePath, "utf8");
      if (!rawState.trim()) {
        return;
      }

      const parsedState = JSON.parse(rawState) as unknown;
      const stateRecord = asRecord(parsedState);
      const routes = asRecord(stateRecord?.["roomThreadRoutes"]);
      if (!routes) {
        return;
      }

      for (const [roomId, threadId] of Object.entries(routes)) {
        if (typeof threadId === "string" && roomId && threadId) {
          this.roomThreadRoutes.set(roomId, threadId);
        }
      }

      this.logInfo(`Loaded ${String(this.roomThreadRoutes.size)} persisted room-thread route(s)`);
    } catch (error) {
      const isMissingFileError =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT";

      if (isMissingFileError) {
        return;
      }

      this.logWarn(`Failed to load room-thread routes from ${this.routingPersistencePath}: ${String(error)}`);
    }
  }

  private persistRoomThreadRoutes(): void {
    try {
      mkdirSync(dirname(this.routingPersistencePath), { recursive: true });
      const serializableState = {
        roomThreadRoutes: Object.fromEntries(this.roomThreadRoutes.entries())
      };
      writeFileSync(this.routingPersistencePath, `${JSON.stringify(serializableState, null, 2)}\n`, "utf8");
    } catch (error) {
      this.logWarn(`Failed to persist room-thread routes to ${this.routingPersistencePath}: ${String(error)}`);
    }
  }

  private stringifyJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private toJsonSnippet(value: unknown, maxLength = 3500): string {
    return this.truncateForMessage(this.stringifyJson(value), maxLength);
  }

  private truncateForMessage(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength)}\n... (truncated)`;
  }

  private async sendTextMessage(roomId: string, body: string): Promise<void> {
    await this.channel.sendTextMessage(roomId, new ChannelOutboundMessage({ body }));
  }

  private async sendNoticeMessage(roomId: string, body: string): Promise<void> {
    await this.channel.sendNoticeMessage(roomId, new ChannelOutboundMessage({ body }));
  }

  private async sendRichTextMessage(roomId: string, body: string, formattedBody?: string): Promise<void> {
    await this.channel.sendRichTextMessage(
      roomId,
      new ChannelOutboundMessage({
        body,
        formattedBody: formattedBody?.trim() ? formattedBody : undefined,
        format: "org.matrix.custom.html"
      })
    );
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private logInfo(message: string): void {
    console.info("[slimebot]", message);
  }

  private logWarn(message: string): void {
    console.warn("[slimebot]", message);
  }

  private logError(message: string): void {
    console.error("[slimebot]", message);
  }
}
