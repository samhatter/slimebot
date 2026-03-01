import { resolve } from "node:path";
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
import { formatJsonResponse, formatModelList, formatThreadList, formatThreadStatus } from "./controllerFormatting.js";
import {
  describeToolLikeItem,
  escapeHtml,
  extractThreadDefaultEffort,
  extractToolEventSnapshot,
  getRedirectUriFromAuthUrl,
  getToolActivityKey,
  normalizeCallbackUrl,
  readStringFromAny,
  shouldIgnoreCodexLogLine,
  stringifyJson,
  toJsonSnippet
} from "./controllerUtils.js";
import { loadPersistedRoomThreadRoutes, persistRoomThreadRoutes } from "./routingPersistence.js";

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
  startedAtMs: number;
};

type ReasoningEffort = "low" | "medium" | "high";

type ThreadTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  lastTotalTokens?: number;
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
  private readonly reasoningEffortByThreadId = new Map<string, ReasoningEffort>();
  private readonly selectedModelByThreadId = new Map<string, string>();
  private readonly tokenUsageByThreadId = new Map<string, ThreadTokenUsage>();
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
      if (shouldIgnoreCodexLogLine(line)) {
        return;
      }

      this.logInfo(`[codex.stdout] ${line}`);
    });

    this.codexAppServer.on("stderr", (line: string) => {
      if (shouldIgnoreCodexLogLine(line)) {
        return;
      }

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
      const threadId = readStringFromAny(record?.["threadId"], turn?.["threadId"]);
      const turnId = readStringFromAny(record?.["turnId"], turn?.["id"]);

      if (!threadId || !turnId) {
        return;
      }

      this.inFlightTurnByThreadId.set(threadId, turnId);
      this.updateSelectedModelForThread(threadId, record);
    });

    this.codexAppServer.on("notification:turn/completed", async (params: unknown) => {
      const record = asRecord(params);
      const turn = asRecord(record?.["turn"]);
      const threadId = readStringFromAny(record?.["threadId"], turn?.["threadId"]);
      const turnId = readStringFromAny(record?.["turnId"], turn?.["id"]);

      if (!threadId) {
        return;
      }

      this.updateSelectedModelForThread(threadId, record);

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

    this.codexAppServer.on("notification:model/rerouted", (params: unknown) => {
      const record = asRecord(params);
      const threadId = readStringFromAny(record?.["threadId"]);
      const toModel = readStringFromAny(record?.["toModel"]);
      if (!threadId || !toModel) {
        return;
      }

      this.selectedModelByThreadId.set(threadId, toModel);
    });

    this.codexAppServer.on("notification:thread/tokenUsage/updated", (params: unknown) => {
      const record = asRecord(params);
      const threadId = readStringFromAny(record?.["threadId"]);
      if (!threadId) {
        return;
      }

      this.updateTokenUsageForThread(threadId, record);
    });

    this.codexAppServer.on("notification:codex/event/token_count", (params: unknown) => {
      const record = asRecord(params);
      const threadId = readStringFromAny(record?.["conversationId"], record?.["threadId"]);
      if (!threadId) {
        return;
      }

      this.updateSelectedModelForThread(threadId, record);
    });

    this.codexAppServer.on("notification:item/started", async (params: unknown) => {
      const record = asRecord(params);
      const item = asRecord(record?.["item"]);
      const threadId = readStringFromAny(record?.["threadId"]);
      const turnId = readStringFromAny(record?.["turnId"]);
      const itemId = readStringFromAny(item?.["id"]);
      const itemType = readStringFromAny(item?.["type"]);

      if (!threadId || !itemId || !itemType || !item) {
        return;
      }

      if (!describeToolLikeItem(itemType, item)) {
        return;
      }

      const toolSnapshot = extractToolEventSnapshot(item);
      const toolSnapshotJson = toolSnapshot ? toJsonSnippet(toolSnapshot, 1800) : undefined;

      const key = getToolActivityKey(threadId, itemId);
      if (this.pendingToolActivityByKey.has(key)) {
        return;
      }

      this.pendingToolActivityByKey.set(key, {
        threadId,
        turnId,
        itemId,
        itemType,
        startedAtMs: Date.now()
      });

      const roomId = this.getRoomIdByThreadId(threadId);
      if (!roomId) {
        return;
      }

      await this.sendRichTextMessage(
        roomId,
        [
          `Tool: ${itemType}`,
          toolSnapshotJson
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        [
          `<p><b>Tool:</b> ${escapeHtml(itemType)}</p>`,
          toolSnapshotJson
            ? `<pre><code>${escapeHtml(toolSnapshotJson)}</code></pre>`
            : ""
        ].join("")
      );
    });

    this.codexAppServer.on("notification:item/completed", async (params: unknown) => {
      const record = asRecord(params);
      const item = asRecord(record?.["item"]);
      const threadId = readStringFromAny(record?.["threadId"]);
      const turnId = readStringFromAny(record?.["turnId"]);
      const itemId = readStringFromAny(item?.["id"]);
      const itemType = readStringFromAny(item?.["type"]);

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
              `<li><b>threadId:</b> <code>${escapeHtml(threadId)}</code></li>`,
              turnId ? `<li><b>turnId:</b> <code>${escapeHtml(turnId)}</code></li>` : "",
              "</ul>"
            ].join("")
          );
        }
      }

      const key = getToolActivityKey(threadId, itemId);
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
      const itemError = readStringFromAny(asRecord(item?.["error"])?.["message"], item?.["error"]);
      const completionLabel = itemError ? "Tool failed" : "Tool completed";
      const completionSnapshot = item ? extractToolEventSnapshot(item) : undefined;
      const completionSnapshotJson = completionSnapshot ? toJsonSnippet(completionSnapshot, 1800) : undefined;

      await this.sendRichTextMessage(
        roomId,
        [
          `${completionLabel}: ${pendingToolActivity.itemType} (${elapsedSeconds}s)`,
          itemError ? `error: ${itemError}` : undefined,
          completionSnapshotJson
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        [
          `<p><b>${escapeHtml(completionLabel)}:</b> ${escapeHtml(pendingToolActivity.itemType)} (${escapeHtml(elapsedSeconds)}s)</p>`,
          itemError ? `<p><b>error:</b> ${escapeHtml(itemError)}</p>` : "",
          completionSnapshotJson
            ? `<pre><code>${escapeHtml(completionSnapshotJson)}</code></pre>`
            : ""
        ].join("")
      );
    });

    this.codexAppServer.on("notification:serverRequest/resolved", (params: unknown) => {
      const record = asRecord(params);
      const requestId = readStringFromAny(record?.["requestId"]);
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
      const turnStartParams: Record<string, unknown> = {
        threadId,
        input: [
          {
            type: "text",
            text: body
          }
        ]
      };

      const reasoningEffort = this.reasoningEffortByThreadId.get(threadId);
      if (reasoningEffort) {
        turnStartParams["effort"] = reasoningEffort;
      }

      const result = await this.codexAppServer.turnStart(turnStartParams);

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
    const threadId = readStringFromAny(record?.["threadId"]);
    const turnId = readStringFromAny(record?.["turnId"]);
    const itemId = readStringFromAny(record?.["itemId"]);

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

    const reason = readStringFromAny(record?.["reason"]);
    const approvalType = method === "item/fileChange/requestApproval" ? "file change" : "command";
    const commandPreview = Array.isArray(record?.["command"])
      ? (record?.["command"] as unknown[]).filter((part): part is string => typeof part === "string").join(" ")
      : "";

    const approvalLines = [
      `<b>Approval requested for ${escapeHtml(approvalType)}</b>`,
      `<ul>`,
      `<li><b>threadId:</b> <code>${escapeHtml(threadId)}</code></li>`,
      `<li><b>turnId:</b> <code>${escapeHtml(turnId)}</code></li>`,
      `<li><b>itemId:</b> <code>${escapeHtml(itemId)}</code></li>`,
      commandPreview ? `<li><b>command:</b> <code>${escapeHtml(commandPreview)}</code></li>` : undefined,
      reason ? `<li><b>reason:</b> ${escapeHtml(reason)}</li>` : undefined,
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
      case "thread":
        await this.handleThreadCommand(roomId, command);
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
      case "reasoning":
        await this.handleReasoningCommand(roomId, command);
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
      "- !thread list [archived|true]: List recent threads",
      "- !thread status [threadId]: Show status for a thread (mapped thread by default)",
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
      "- !account: Show account information",
      "- !reasoning [off|low|medium|high] [threadId]: Show or set reasoning per thread (!r)"
    ];

    const formattedBody = [
      "<b>Available commands</b>",
      "<ul>",
      ...lines.slice(1).map((line) => {
        const [command, ...descriptionParts] = line.slice(2).split(":");
        const description = descriptionParts.join(":").trim();
        return `<li><code>${escapeHtml(command.trim())}</code>: ${escapeHtml(description)}</li>`;
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
        await this.sendTextMessage(roomId, `Thread was created but no thread id was returned:\n${stringifyJson(result)}`);
        return;
      }

      if (typeof threadId !== "string") {
        await this.sendTextMessage(roomId, `Thread response had invalid thread.id:\n${stringifyJson(result)}`);
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
        await this.sendTextMessage(roomId, `Thread resume response missing thread.id:\n${stringifyJson(result)}`);
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

  private async handleThreadCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.sendTextMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const subcommandArg = command.args[0]?.trim().toLowerCase();

    if (!subcommandArg || subcommandArg === "list" || subcommandArg === "archived" || subcommandArg === "true") {
      const archivedArg = subcommandArg === "list" ? command.args[1]?.toLowerCase() : subcommandArg;
      const archived = archivedArg === "archived" || archivedArg === "true";

      try {
        const result = await this.codexAppServer.threadList({
          limit: 20,
          sortKey: "updated_at",
          archived
        });
        const formattedThreadList = formatThreadList(result, archived);
        await this.sendRichTextMessage(roomId, formattedThreadList.body, formattedThreadList.formattedBody);
      } catch (error) {
        await this.sendTextMessage(roomId, `Failed to list threads: ${String(error)}`);
        this.logWarn(`Failed to list threads: ${String(error)}`);
      }
      return;
    }

    if (subcommandArg === "status") {
      const threadId = this.resolveThreadIdForCommand(roomId, command.args[1]?.trim(), "!thread status [threadId]");
      if (!threadId) {
        return;
      }

      try {
        const result = await this.codexAppServer.threadRead({ threadId });
        const threadRecord = asRecord(asRecord(result)?.["thread"]);
        if (!threadRecord) {
          const threadStatusResponse = formatJsonResponse("Thread status response", result);
          await this.sendRichTextMessage(roomId, threadStatusResponse.body, threadStatusResponse.formattedBody);
          return;
        }

        const name = readStringFromAny(threadRecord["name"]) ?? "-";
        const preview = readStringFromAny(threadRecord["preview"]) ?? "-";
        const updatedAt = readStringFromAny(threadRecord["updatedAt"], threadRecord["createdAt"]) ?? "-";
        const modelProvider = readStringFromAny(threadRecord["modelProvider"]) ?? "-";
        const selectedModel =
          readStringFromAny(
            threadRecord["model"],
            asRecord(threadRecord["settings"])?.["model"],
            asRecord(threadRecord["defaultSettings"])?.["model"]
          )
          ?? this.selectedModelByThreadId.get(threadId)
          ?? "-";
        const statusType = readStringFromAny(asRecord(threadRecord["status"])?.["type"], threadRecord["status"]) ?? "-";
        const agentNickname = readStringFromAny(threadRecord["agentNickname"]) ?? "-";
        const agentRole = readStringFromAny(threadRecord["agentRole"]) ?? "-";
        const archived = threadRecord["archived"] === true ? "yes" : "no";
        const defaultEffort = extractThreadDefaultEffort(threadRecord) ?? "default";

        this.updateTokenUsageForThread(threadId, threadRecord);
        const tokenUsage = this.tokenUsageByThreadId.get(threadId);
        const inputTokens = tokenUsage?.inputTokens;
        const outputTokens = tokenUsage?.outputTokens;
        const totalTokens = tokenUsage?.totalTokens;
        const lastInputTokens = tokenUsage?.lastInputTokens;
        const lastOutputTokens = tokenUsage?.lastOutputTokens;
        const lastTotalTokens = tokenUsage?.lastTotalTokens;

        const formattedStatus = formatThreadStatus({
          threadId,
          name,
          preview,
          updatedAt,
          modelProvider,
          selectedModel,
          statusType,
          agentNickname,
          agentRole,
          totalInputTokens: inputTokens,
          totalOutputTokens: outputTokens,
          totalTokens,
          lastInputTokens,
          lastOutputTokens,
          lastTotalTokens,
          archived,
          defaultEffort
        });

        await this.sendRichTextMessage(roomId, formattedStatus.body, formattedStatus.formattedBody);
      } catch (error) {
        await this.sendTextMessage(roomId, `Failed to read thread ${threadId}: ${String(error)}`);
        this.logWarn(`Failed to read thread ${threadId}: ${String(error)}`);
      }
      return;
    }

    await this.sendTextMessage(roomId, "Usage: !thread <list|status> [args]");
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
      await this.sendTextMessage(roomId, `Rollback completed for ${threadId}.\n${stringifyJson(result)}`);
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
      await this.sendTextMessage(roomId, `Unarchived thread ${threadId}.\n${stringifyJson(result)}`);
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
    if (
      pendingApproval.method === "item/commandExecution/requestApproval"
      || pendingApproval.method === "item/fileChange/requestApproval"
    ) {
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
      const formattedModelList = formatModelList(result);
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
      const accountResponse = formatJsonResponse("Account response", result);
      await this.sendRichTextMessage(roomId, accountResponse.body, accountResponse.formattedBody);
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to read account: ${String(error)}`);
      this.logWarn(`Failed to read account: ${String(error)}`);
    }
  }

  private async handleReasoningCommand(roomId: string, command: ControllerCommand): Promise<void> {
    const usage = "!reasoning [off|low|medium|high] [threadId]";
    const firstArg = command.args[0]?.trim();
    const firstArgLower = firstArg?.toLowerCase();

    if (!firstArgLower) {
      const mappedThreadId = this.roomThreadRoutes.get(roomId);
      if (!mappedThreadId) {
        await this.sendTextMessage(roomId, `No mapped thread for this room. Usage: ${usage}`);
        return;
      }

      let codexEffort: string | undefined;
      if (this.codexAppServer) {
        try {
          const threadReadResult = await this.codexAppServer.threadRead({ threadId: mappedThreadId });
          const threadRecord = asRecord(asRecord(threadReadResult)?.["thread"]);
          const effort = extractThreadDefaultEffort(threadRecord);
          if (effort) {
            codexEffort = effort;
          }
        } catch (error) {
          this.logWarn(`Failed to read thread ${mappedThreadId} for reasoning status: ${String(error)}`);
        }
      }

      const effort = this.reasoningEffortByThreadId.get(mappedThreadId);
      const effectiveEffort = effort ?? codexEffort ?? "default";
      await this.sendTextMessage(
        roomId,
        `Effective next turn reasoning for ${mappedThreadId}: ${effectiveEffort}`
      );
      return;
    }

    const isValidEffort = firstArgLower === "low" || firstArgLower === "medium" || firstArgLower === "high";
    const isOff = firstArgLower === "off";

    if (!isValidEffort && !isOff) {
      const threadId = firstArg;
      let codexEffort: string | undefined;
      if (this.codexAppServer) {
        try {
          const threadReadResult = await this.codexAppServer.threadRead({ threadId });
          const threadRecord = asRecord(asRecord(threadReadResult)?.["thread"]);
          codexEffort = extractThreadDefaultEffort(threadRecord);
        } catch (error) {
          this.logWarn(`Failed to read thread ${threadId} for reasoning status: ${String(error)}`);
        }
      }

      const effort = this.reasoningEffortByThreadId.get(threadId);
      const effectiveEffort = effort ?? codexEffort ?? "default";
      await this.sendTextMessage(
        roomId,
        `Effective next turn reasoning for ${threadId}: ${effectiveEffort}`
      );
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[1]?.trim(), usage);
    if (!threadId) {
      return;
    }

    if (isOff) {
      this.reasoningEffortByThreadId.delete(threadId);
      await this.sendTextMessage(roomId, `Reasoning for ${threadId} reset to default (in-memory, not persisted).`);
      return;
    }

    this.reasoningEffortByThreadId.set(threadId, firstArgLower);
    await this.sendTextMessage(roomId, `Reasoning for ${threadId} set to ${firstArgLower} (in-memory, not persisted).`);
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
      this.pendingLoginRedirectUri = getRedirectUriFromAuthUrl(authUrl);

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

    const callbackUrl = normalizeCallbackUrl(callbackInput, this.pendingLoginRedirectUri);
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

  private updateTokenUsageForThread(threadId: string, payload: unknown): void {
    const record = asRecord(payload);
    const tokenUsageRecord = asRecord(record?.["tokenUsage"]);
    if (!tokenUsageRecord) {
      return;
    }

    const totalRecord = asRecord(tokenUsageRecord["total"]);
    const lastRecord = asRecord(tokenUsageRecord["last"]);
    const inputTokens = typeof totalRecord?.["inputTokens"] === "number" ? Math.trunc(totalRecord["inputTokens"]) : undefined;
    const outputTokens = typeof totalRecord?.["outputTokens"] === "number" ? Math.trunc(totalRecord["outputTokens"]) : undefined;
    const totalTokens = typeof totalRecord?.["totalTokens"] === "number" ? Math.trunc(totalRecord["totalTokens"]) : undefined;
    const lastInputTokens = typeof lastRecord?.["inputTokens"] === "number" ? Math.trunc(lastRecord["inputTokens"]) : undefined;
    const lastOutputTokens = typeof lastRecord?.["outputTokens"] === "number" ? Math.trunc(lastRecord["outputTokens"]) : undefined;
    const lastTotalTokens = typeof lastRecord?.["totalTokens"] === "number" ? Math.trunc(lastRecord["totalTokens"]) : undefined;

    const existingUsage = this.tokenUsageByThreadId.get(threadId) ?? {};
    this.tokenUsageByThreadId.set(threadId, {
      inputTokens: inputTokens ?? existingUsage.inputTokens,
      outputTokens: outputTokens ?? existingUsage.outputTokens,
      totalTokens: totalTokens ?? existingUsage.totalTokens,
      lastInputTokens: lastInputTokens ?? existingUsage.lastInputTokens,
      lastOutputTokens: lastOutputTokens ?? existingUsage.lastOutputTokens,
      lastTotalTokens: lastTotalTokens ?? existingUsage.lastTotalTokens
    });
  }

  private updateSelectedModelForThread(threadId: string, payload: unknown): void {
    const record = asRecord(payload);
    const messageRecord = asRecord(record?.["msg"]);
    const rateLimitsRecord = asRecord(record?.["rateLimits"]);
    const messageRateLimitsRecord = asRecord(messageRecord?.["rate_limits"]);
    const turnRecord = asRecord(record?.["turn"]);
    const threadRecord = asRecord(record?.["thread"]);
    const model = readStringFromAny(
      record?.["toModel"],
      record?.["model"],
      rateLimitsRecord?.["limitName"],
      messageRateLimitsRecord?.["limit_name"],
      turnRecord?.["model"],
      asRecord(turnRecord?.["settings"])?.["model"],
      threadRecord?.["model"],
      asRecord(threadRecord?.["settings"])?.["model"]
    );

    if (model) {
      this.selectedModelByThreadId.set(threadId, model);
    }
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

  private loadRoomThreadRoutes(): void {
    const persistedRoutes = loadPersistedRoomThreadRoutes(
      this.routingPersistencePath,
      this.logInfo.bind(this),
      this.logWarn.bind(this)
    );
    for (const [roomId, threadId] of persistedRoutes.entries()) {
      this.roomThreadRoutes.set(roomId, threadId);
    }
  }

  private persistRoomThreadRoutes(): void {
    persistRoomThreadRoutes(this.routingPersistencePath, this.roomThreadRoutes, this.logWarn.bind(this));
  }

  private async sendTextMessage(roomId: string, body: string): Promise<void> {
    await this.channel.sendTextMessage(roomId, new ChannelOutboundMessage({ body }));
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
