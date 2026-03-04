/**
 * @fileoverview Main bot orchestration controller that bridges channel events
 * and Codex app-server interactions.
 */

import { resolve } from "node:path";
import {
  type Channel
} from "../channels/channel.js";
import { createChannel } from "../channels/index.js";
import type { AppConfig } from "../config/config.js";
import { CodexAppServerProcess } from "../codexProcess/codexAppServerProcess.js";
import {
  getAgentMessageFromItemCompleted,
  parseCodexServerNotification,
  parseCodexServerRequest,
  parseThreadReadResult,
  type AccountRateLimitsUpdatedNotification,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type TurnCompletedNotification,
  type TurnStartedNotification
} from "../codexProcess/codexV2Schema.js";
import {
  asRecord,
  getAuthUrlFromLoginResult
} from "./commands.js";
import type { ControllerCommand } from "../channels/commands.js";
import {
  describeToolLikeItem,
  extractToolEventSnapshot,
  getRedirectUriFromAuthUrl,
  getToolActivityKey,
  normalizeCallbackUrl,
  readStringFromAny,
  shouldIgnoreCodexLogLine,
  stringifyJson
} from "./controllerUtils.js";
import { ControllerMcpSocketServer } from "./controllerMcpSocketServer.js";
import { StateDatabase, type ActiveScheduleJobRecord, type ScheduleJobRecord } from "./stateDatabase.js";
import { computeNextScheduleRunAtMs, normalizeScheduleSpec, type ScheduleSpec } from "./scheduleSpec.js";

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

type ThreadState = {
  inFlightTurnId?: string;
  pendingCompaction?: boolean;
  pendingInterruptTurnId?: string;
  reasoningEffort?: ReasoningEffort;
  modelOverride?: string;
  tokenUsage?: ThreadTokenUsage;
};

type ScheduledJob = ScheduleJobRecord & {
  timeout?: NodeJS.Timeout;
};

export class BotController {
  private readonly channel: Channel;
  private readonly codexAppServer?: CodexAppServerProcess;
  private readonly mcpSocketServer: ControllerMcpSocketServer;
  private readonly stateDatabase: StateDatabase;
  private readonly roomThreadRoutes = new Map<string, string>();
  private readonly threadStateByThreadId = new Map<string, ThreadState>();
  private readonly pendingToolActivityByKey = new Map<string, PendingToolActivity>();
  private readonly pendingApprovalByRoomId = new Map<string, PendingApprovalRequest>();
  private readonly pendingApprovalRoomByRequestId = new Map<string, string>();
  private readonly scheduledJobsById = new Map<number, ScheduledJob>();
  private toolActivityMessagesEnabled = true;
  private latestAccountRateLimits?: unknown;
  private loginRoomId?: string;
  private pendingLoginRedirectUri?: string;

  /**
   * Creates a controller with channel + optional Codex process wiring.
   */
  public constructor(appConfig: AppConfig) {
    this.channel = createChannel(appConfig.channel);
    this.stateDatabase = new StateDatabase(
      resolve(appConfig.controller.stateDatabasePath),
      this.logInfo.bind(this),
      this.logWarn.bind(this)
    );
    this.mcpSocketServer = new ControllerMcpSocketServer(
      resolve(appConfig.controller.mcpSocketPath),
      {
        listSchedules: (roomId?: string) => this.listSchedulesForMcp(roomId),
        createSchedule: (input) => this.createScheduleForMcp(input),
        cancelSchedule: (roomId: string, id: number) => this.cancelScheduleForMcp(roomId, id)
      },
      this.channel.getMcpToolDefinitions(),
      this.logInfo.bind(this),
      this.logWarn.bind(this)
    );
    this.loadPersistedState();

    if (appConfig.codex.command) {
      this.codexAppServer = new CodexAppServerProcess(
        appConfig.codex.command,
        appConfig.codex.args,
        appConfig.codex.options
      );
    }
  }

  /**
   * Starts bot orchestration, restores persisted mappings, and starts the channel.
   */
  public async start(): Promise<void> {
    this.registerChannelEventHandlers();

    if (this.codexAppServer) {
      this.registerCodexEventHandlers();
    }

    this.registerShutdownHandlers();

    this.codexAppServer?.start();
    await this.initializeCodexAppServer();
    await this.restoreRoomThreadRoutes();
    this.restoreScheduledMessages();
    await this.mcpSocketServer.start();

    await this.channel.start();
    this.logInfo("Bot runner started");
  }

  /** Registers process signal handlers to stop the Codex app server cleanly. */
  private registerShutdownHandlers(): void {
    const shutdown = (): void => {
      this.clearAllScheduledMessageTimers();
      void this.mcpSocketServer.stop();
      this.codexAppServer?.stop("SIGTERM");
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  /** Registers inbound channel message handling and command routing. */
  private registerChannelEventHandlers(): void {
    this.channel.onMessage(async ({ roomId, sender, body, originServerTs, command }) => {
      if (command) {
        await this.handleCommand(roomId, command);
        return;
      }

      if (!this.codexAppServer || !body) {
        return;
      }

      const threadId = this.roomThreadRoutes.get(roomId);
      if (!threadId) {
        await this.channel.sendSystemMessage(roomId, "No Codex thread is mapped to this room yet. Run !new to create one.");
        return;
      }

      await this.sendUserMessageToThread(roomId, threadId, body);
    });
  }

  /** Registers Codex app-server event and request handlers. */
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
        await this.channel.sendCodexReply(replyMessage.roomId, replyMessage.body);
      } catch (error) {
        this.logWarn(`Failed to send Codex reply to room ${replyMessage.roomId}: ${String(error)}`);
      }
    });

    this.codexAppServer.on("notification:account/login/completed", async (params: unknown) => {
      const notification = parseCodexServerNotification({
        method: "account/login/completed",
        params
      });
      if (!notification || notification.method !== "account/login/completed") {
        return;
      }

      const roomId = this.loginRoomId;
      if (!roomId) {
        return;
      }

      const { success, error } = notification.params;

      if (success === true) {
        await this.channel.sendSystemMessage(roomId, "Login completed successfully.");
      } else {
        const errorText = typeof error === "string" && error ? error : "unknown error";
        await this.channel.sendSystemMessage(roomId, `Login failed: ${errorText}`);
      }

      this.pendingLoginRedirectUri = undefined;
      this.loginRoomId = undefined;
    });

    this.codexAppServer.on("notification:turn/started", (params: unknown) => {
      const notification = parseCodexServerNotification({
        method: "turn/started",
        params
      });
      if (!notification || notification.method !== "turn/started") {
        return;
      }

      const { threadId } = notification.params as TurnStartedNotification;
      const turnId = notification.params.turn.id;

      if (!threadId || !turnId) {
        return;
      }

      this.setThreadInFlightTurnId(threadId, turnId);

      const roomId = this.getRoomIdByThreadId(threadId);
      if (roomId) {
        void this.channel.indicateTurnStarted(roomId);
      }
    });

    this.codexAppServer.on("notification:turn/completed", async (params: unknown) => {
      const notification = parseCodexServerNotification({
        method: "turn/completed",
        params
      });
      if (!notification || notification.method !== "turn/completed") {
        return;
      }

      const { threadId } = notification.params as TurnCompletedNotification;
      const turnId = notification.params.turn.id;

      if (!threadId) {
        return;
      }

      const roomId = this.getRoomIdByThreadId(threadId);
      if (roomId) {
        void this.channel.indicateTurnEnded(roomId);
      }

      const pendingInterruptTurnId = this.getThreadState(threadId)?.pendingInterruptTurnId;
      if (pendingInterruptTurnId && (!turnId || pendingInterruptTurnId === turnId)) {
        this.setThreadPendingInterruptTurnId(threadId, undefined);

        const roomId = this.getRoomIdByThreadId(threadId);
        if (roomId) {
          await this.channel.sendSystemMessage(
            roomId,
            turnId
              ? `Interrupt completed for turn ${turnId} on thread ${threadId}.`
              : `Interrupt completed for thread ${threadId}.`
          );
        }
      }

      const currentTurnId = this.getThreadState(threadId)?.inFlightTurnId;
      if (!currentTurnId) {
        return;
      }

      if (!turnId || currentTurnId === turnId) {
        this.setThreadInFlightTurnId(threadId, undefined);
      }

      this.clearPendingToolActivity(threadId, turnId);
    });

    this.codexAppServer.on("notification:thread/tokenUsage/updated", (params: unknown) => {
      const notification = parseCodexServerNotification({
        method: "thread/tokenUsage/updated",
        params
      });
      if (!notification || notification.method !== "thread/tokenUsage/updated") {
        return;
      }

      const { threadId, tokenUsage } = notification.params;
      if (!threadId) {
        return;
      }

      this.updateTokenUsageForThread(threadId, { tokenUsage });
    });

    this.codexAppServer.on("notification:account/rateLimits/updated", (params: unknown) => {
      const notification = parseCodexServerNotification({
        method: "account/rateLimits/updated",
        params
      });
      if (!notification || notification.method !== "account/rateLimits/updated") {
        return;
      }

      this.latestAccountRateLimits = (notification.params as AccountRateLimitsUpdatedNotification).rateLimits;
    });

    this.codexAppServer.on("notification:item/started", async (params: unknown) => {
      const notification = parseCodexServerNotification({
        method: "item/started",
        params
      });
      if (!notification || notification.method !== "item/started") {
        return;
      }

      const { threadId, turnId, item } = notification.params as ItemStartedNotification;
      const itemId = readStringFromAny(item.id);
      const itemType = readStringFromAny(item.type);

      if (!threadId || !itemId || !itemType || !item) {
        return;
      }

      if (!describeToolLikeItem(itemType, item)) {
        return;
      }

      const toolSnapshot = extractToolEventSnapshot(item);

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

      if (!this.toolActivityMessagesEnabled) {
        return;
      }

      await this.channel.sendToolActivityStarted(roomId, {
        itemType,
        snapshot: toolSnapshot
      });
    });

    this.codexAppServer.on("notification:item/completed", async (params: unknown) => {
      const notification = parseCodexServerNotification({
        method: "item/completed",
        params
      });
      if (!notification || notification.method !== "item/completed") {
        return;
      }

      const { threadId, turnId, item } = notification.params as ItemCompletedNotification;
      const itemId = readStringFromAny(item.id);
      const itemType = readStringFromAny(item.type);

      if (!threadId || !itemId || !itemType) {
        return;
      }

      if (itemType.toLowerCase() === "contextcompaction" && this.getThreadState(threadId)?.pendingCompaction) {
        this.setThreadPendingCompaction(threadId, false);
        const roomIdForCompaction = this.getRoomIdByThreadId(threadId);
        if (roomIdForCompaction) {
          await this.channel.sendCompactionCompleted(roomIdForCompaction, threadId, turnId);
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

      if (!this.toolActivityMessagesEnabled) {
        return;
      }

      const elapsedMs = Math.max(0, Date.now() - pendingToolActivity.startedAtMs);
      const elapsedSeconds = (elapsedMs / 1000).toFixed(1);
      const itemError = readStringFromAny(asRecord(item.error)?.["message"], item.error);
      const completionLabel = itemError ? "Tool failed" : "Tool completed";
      const completionSnapshot = item ? extractToolEventSnapshot(item) : undefined;

      await this.channel.sendToolActivityCompleted(roomId, {
        completionLabel,
        itemType: pendingToolActivity.itemType,
        elapsedSeconds,
        itemError: itemError ?? undefined,
        snapshot: completionSnapshot
      });
    });

    this.codexAppServer.on("notification:serverRequest/resolved", (params: unknown) => {
      const notification = parseCodexServerNotification({
        method: "serverRequest/resolved",
        params
      });
      if (!notification || notification.method !== "serverRequest/resolved") {
        return;
      }

      const requestId = readStringFromAny(notification.params.requestId);
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

  /** Sends user input to an active turn or starts a new turn when idle. */
  private async sendUserMessageToThread(roomId: string, threadId: string, body: string): Promise<void> {
    if (!this.codexAppServer) {
      return;
    }

    const inFlightTurnId = this.getThreadState(threadId)?.inFlightTurnId;
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
        this.setThreadInFlightTurnId(threadId, undefined);
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

      const reasoningEffort = this.getThreadState(threadId)?.reasoningEffort;
      if (reasoningEffort) {
        turnStartParams["effort"] = reasoningEffort;
      }

      const modelOverride = this.getThreadState(threadId)?.modelOverride;
      if (modelOverride) {
        turnStartParams["model"] = modelOverride;
      }

      const result = await this.codexAppServer.turnStart(turnStartParams);

      const turnId = readStringFromAny(asRecord(asRecord(result)?.["turn"])?.["id"]);
      if (turnId) {
        this.setThreadInFlightTurnId(threadId, turnId);
      }
    } catch (error) {
      this.logWarn(`Failed to send message to Codex thread ${threadId}: ${String(error)}`);
      await this.channel.sendSystemMessage(roomId, `Failed to send message to Codex: ${String(error)}`);
    }
  }

  /** Handles Codex approval requests and prompts the mapped room for a decision. */
  private async handleApprovalRequest(
    requestId: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    if (!this.codexAppServer) {
      return;
    }

    const request = parseCodexServerRequest(requestId, method, params);
    if (!request) {
      this.codexAppServer.respondSuccess(requestId, { decision: "decline" });
      return;
    }

    const { threadId, turnId, itemId } = request.params;

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

    const reason = readStringFromAny(request.params.reason);
    const approvalType = request.method === "item/fileChange/requestApproval" ? "file change" : "command";
    const commandPreview = request.method === "item/commandExecution/requestApproval"
      ? readStringFromAny(request.params.command)
      : "";

    await this.channel.sendApprovalRequest(roomId, {
      approvalType,
      threadId,
      turnId,
      itemId,
      commandPreview: commandPreview || undefined,
      reason: reason || undefined
    });
  }

  /** Parses a Codex message payload into a room-scoped assistant reply. */
  private parseCodexReplyMessage(message: unknown): { roomId: string; body: string } | undefined {
    const record = asRecord(message);
    if (!record) {
      return undefined;
    }

    const roomId = record["roomId"];
    const body = record["body"];

    if (typeof roomId !== "string" || typeof body !== "string") {
      const notification = parseCodexServerNotification(message);
      if (!notification || notification.method !== "item/completed") {
        return undefined;
      }

      const reply = getAgentMessageFromItemCompleted(notification.params);
      if (!reply) {
        return undefined;
      }

      const threadId = reply.threadId;
      const itemText = reply.body;

      const mappedRoomId = this.getRoomIdByThreadId(threadId);
      if (!mappedRoomId || !itemText) {
        return undefined;
      }

      return {
        roomId: mappedRoomId,
        body: itemText
      };
    }

    return { roomId, body };
  }

  /** Finds the room currently mapped to the given thread id. */
  private getRoomIdByThreadId(threadId: string): string | undefined {
    for (const [roomId, mappedThreadId] of this.roomThreadRoutes.entries()) {
      if (mappedThreadId === threadId) {
        return roomId;
      }
    }

    return undefined;
  }

  /** Dispatches parsed commands to their concrete handler methods. */
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
      case "model":
        await this.handleModelCommand(roomId, command);
        return;
      case "account":
        await this.handleAccountCommand(roomId, command);
        return;
      case "reasoning":
        await this.handleReasoningCommand(roomId, command);
        return;
      case "verbosity":
        await this.handleVerbosityCommand(roomId, command);
        return;
      case "schedule":
        await this.handleScheduleCommand(roomId, command);
        return;
      default:
        return;
    }
  }

  /** Sends command help text for supported bot commands. */
  private async handleHelpCommand(roomId: string): Promise<void> {
    const lines = [
      "Available commands:",
      "- !help: Show this command list",
      "- !new: Create and map a new Codex thread for this room",
      "- !resume <threadId>: Resume a thread and map it to this room",
      "- !thread [threadId]: Show status for a thread (mapped thread by default) (!t)",
      "- !threads [archived|true]: List recent threads",
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
      "- !model <modelId> [threadId]: Set selected model for subsequent turns (!m)",
      "- !account [ratelimits]: Show account information or latest rate limits",
      "- !reasoning [default|low|medium|high] [threadId]: Show or set reasoning per thread (!r)",
      "- !verbosity [on|off]: Show or set tool activity message verbosity (!v)",
      "- !schedule create <timezone> <ISO-8601-dtstart> <RRULE> <message>: Create a recurring (or one-shot) schedule",
      "- !schedule once <ISO-8601> <message>: Convenience one-shot schedule (UTC rule wrapper)",
      "- !schedule list: List active schedules for this room",
      "- !schedule cancel <id>: Cancel an active schedule in this room"
    ];

    await this.channel.sendHelp(roomId, lines);
  }

  /** Creates a new thread and maps it to the current room. */
  private async handleNewCommand(roomId: string): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    try {
      const result = await this.codexAppServer.threadStart({});
      const threadId = asRecord(asRecord(result)?.["thread"])?.["id"];
      if (!threadId) {
        await this.channel.sendSystemMessage(roomId, `Thread was created but no thread id was returned:\n${stringifyJson(result)}`);
        return;
      }

      if (typeof threadId !== "string") {
        await this.channel.sendSystemMessage(roomId, `Thread response had invalid thread.id:\n${stringifyJson(result)}`);
        return;
      }

      const previousThreadId = this.roomThreadRoutes.get(roomId);
      this.roomThreadRoutes.set(roomId, threadId);
      this.persistRoomThreadRoutes();

      await this.channel.sendSystemMessage(
        roomId,
        previousThreadId
          ? `Mapped room to new thread ${threadId} (replaced ${previousThreadId}).`
          : `Mapped room to new thread ${threadId}.`
      );
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to create a new thread: ${String(error)}`);
      this.logWarn(`Failed to create a new thread for room ${roomId}: ${String(error)}`);
    }
  }

  /** Resumes an existing thread and maps it to the current room. */
  private async handleResumeCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = command.args[0]?.trim();
    if (!threadId) {
      await this.channel.sendSystemMessage(roomId, "Usage: !resume <threadId>");
      return;
    }

    try {
      const result = await this.codexAppServer.threadResume({ threadId });
      const resumedThreadId = asRecord(asRecord(result)?.["thread"])?.["id"];
      if (typeof resumedThreadId !== "string" || !resumedThreadId) {
        await this.channel.sendSystemMessage(roomId, `Thread resume response missing thread.id:\n${stringifyJson(result)}`);
        return;
      }

      const previousThreadId = this.roomThreadRoutes.get(roomId);
      this.roomThreadRoutes.set(roomId, resumedThreadId);
      this.persistRoomThreadRoutes();

      await this.channel.sendSystemMessage(
        roomId,
        previousThreadId
          ? `Resumed ${resumedThreadId} and remapped room (replaced ${previousThreadId}).`
          : `Resumed ${resumedThreadId} and mapped it to this room.`
      );
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to resume thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to resume thread ${threadId}: ${String(error)}`);
    }
  }

  /** Shows status for a thread (mapped thread by default). */
  private async handleThreadCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[0]?.trim(), "!thread [threadId]");
    if (!threadId) {
      return;
    }

    try {
      const result = await this.codexAppServer.threadRead({ threadId });
      const parsedThreadRead = parseThreadReadResult(result);
      if (!parsedThreadRead) {
        await this.channel.sendJsonResponse(roomId, "Thread status response", result);
        return;
      }

      const threadRecord = parsedThreadRead.thread;

      const preview = threadRecord.preview;
      const updatedAt = Number.isFinite(threadRecord.updatedAt)
        ? new Date(threadRecord.updatedAt * 1000).toISOString()
        : "-";
      const modelProvider = threadRecord.modelProvider;
      const selectedModel =
        this.getThreadState(threadId)?.modelOverride
        ?? "default";
      const statusType = threadRecord.status.type;
      const defaultEffort = this.getThreadState(threadId)?.reasoningEffort ?? "default";

      const tokenUsage = this.getThreadState(threadId)?.tokenUsage;
      const inputTokens = tokenUsage?.inputTokens;
      const outputTokens = tokenUsage?.outputTokens;
      const totalTokens = tokenUsage?.totalTokens;
      const lastInputTokens = tokenUsage?.lastInputTokens;
      const lastOutputTokens = tokenUsage?.lastOutputTokens;
      const lastTotalTokens = tokenUsage?.lastTotalTokens;

      await this.channel.sendThreadStatus(roomId, {
        threadId,
        preview,
        updatedAt,
        modelProvider,
        selectedModel,
        statusType,
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        totalTokens,
        lastInputTokens,
        lastOutputTokens,
        lastTotalTokens,
        defaultEffort
      });
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to read thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to read thread ${threadId}: ${String(error)}`);
    }
  }

  /** Lists recent threads. */
  private async handleThreadsCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const archivedArg = command.args[0]?.trim().toLowerCase();
    if (archivedArg && archivedArg !== "archived" && archivedArg !== "true") {
      await this.channel.sendSystemMessage(roomId, "Usage: !threads [archived|true]");
      return;
    }

    const archived = archivedArg === "archived" || archivedArg === "true";

    try {
      const result = await this.codexAppServer.threadList({
        limit: 20,
        sortKey: "updated_at",
        archived
      });
      await this.channel.sendThreadList(roomId, result, archived);
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to list threads: ${String(error)}`);
      this.logWarn(`Failed to list threads: ${String(error)}`);
    }
  }

  /** Rolls back turns for a thread by a requested number of turns. */
  private async handleRollbackCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
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
      await this.channel.sendSystemMessage(roomId, `Rollback completed for ${threadId}.\n${stringifyJson(result)}`);
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to rollback thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to rollback thread ${threadId}: ${String(error)}`);
    }
  }

  /** Starts context compaction for a thread when not already in progress. */
  private async handleCompactCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[0]?.trim(), "!compact [threadId]");
    if (!threadId) {
      return;
    }

    if (this.getThreadState(threadId)?.pendingCompaction) {
      await this.channel.sendSystemMessage(roomId, `Compaction is already in progress for ${threadId}.`);
      return;
    }

    this.setThreadPendingCompaction(threadId, true);

    try {
      await this.codexAppServer.threadCompactStart({ threadId });
      await this.channel.sendSystemMessage(roomId, `Started compaction for ${threadId}.`);
    } catch (error) {
      this.setThreadPendingCompaction(threadId, false);
      await this.channel.sendSystemMessage(roomId, `Failed to compact thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to compact thread ${threadId}: ${String(error)}`);
    }
  }

  /** Archives the target thread. */
  private async handleArchiveCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[0]?.trim(), "!archive [threadId]");
    if (!threadId) {
      return;
    }

    try {
      await this.codexAppServer.threadArchive({ threadId });
      await this.channel.sendSystemMessage(roomId, `Archived thread ${threadId}.`);
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to archive thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to archive thread ${threadId}: ${String(error)}`);
    }
  }

  /** Unarchives the target thread. */
  private async handleUnarchiveCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[0]?.trim(), "!unarchive [threadId]");
    if (!threadId) {
      return;
    }

    try {
      const result = await this.codexAppServer.threadUnarchive({ threadId });
      await this.channel.sendSystemMessage(roomId, `Unarchived thread ${threadId}.\n${stringifyJson(result)}`);
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to unarchive thread ${threadId}: ${String(error)}`);
      this.logWarn(`Failed to unarchive thread ${threadId}: ${String(error)}`);
    }
  }

  /** Requests interruption of the currently in-flight turn for a thread. */
  private async handleInterruptCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[0]?.trim(), "!interrupt [threadId]");
    if (!threadId) {
      return;
    }

    const turnId = this.getThreadState(threadId)?.inFlightTurnId;
    if (!turnId) {
      await this.channel.sendSystemMessage(roomId, `No in-flight turn found for thread ${threadId}.`);
      return;
    }

    const pendingInterruptTurnId = this.getThreadState(threadId)?.pendingInterruptTurnId;
    if (pendingInterruptTurnId && pendingInterruptTurnId === turnId) {
      await this.channel.sendSystemMessage(roomId, `Interrupt is already in progress for turn ${turnId}.`);
      return;
    }

    this.setThreadPendingInterruptTurnId(threadId, turnId);

    try {
      await this.codexAppServer.turnInterrupt({ threadId, turnId });
      await this.channel.sendSystemMessage(roomId, `Interrupt requested for turn ${turnId}. You'll be notified when it completes.`);
    } catch (error) {
      this.setThreadPendingInterruptTurnId(threadId, undefined);
      await this.channel.sendSystemMessage(roomId, `Failed to interrupt turn ${turnId}: ${String(error)}`);
      this.logWarn(`Failed to interrupt turn ${turnId} on thread ${threadId}: ${String(error)}`);
    }
  }

  /** Sends accept/decline decisions for pending approval requests. */
  private async handleApprovalDecisionCommand(roomId: string, decision: "accept" | "decline"): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const pendingApproval = this.pendingApprovalByRoomId.get(roomId);
    if (!pendingApproval) {
      await this.channel.sendSystemMessage(roomId, "No pending approval request in this room.");
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
      await this.channel.sendSystemMessage(roomId, "Pending approval request could not be handled.");
      return;
    }

    this.pendingApprovalByRoomId.delete(roomId);
    this.pendingApprovalRoomByRequestId.delete(String(requestId));

    await this.channel.sendSystemMessage(
      roomId,
      decision === "accept" ? "Approval sent to Codex." : "Decline sent to Codex."
    );
  }

  /** Lists available models from Codex and sends formatted output. */
  private async handleModelsCommand(roomId: string): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    try {
      const result = await this.codexAppServer.modelList({ includeHidden: true });
      await this.channel.sendModelList(roomId, result);
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to list models: ${String(error)}`);
      this.logWarn(`Failed to list models: ${String(error)}`);
    }
  }

  /** Sets the active model for subsequent turns on a thread. */
  private async handleModelCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const modelId = command.args[0]?.trim();
    if (!modelId) {
      await this.channel.sendSystemMessage(roomId, "Usage: !model <modelId> [threadId]");
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[1]?.trim(), "!model <modelId> [threadId]");
    if (!threadId) {
      return;
    }

    if (modelId.toLowerCase() === "default") {
      this.setThreadModelOverride(threadId, undefined);
      await this.channel.sendSystemMessage(
        roomId,
        `Cleared model override for ${threadId}. Future turn starts will use the runtime default model.`
      );
      return;
    }

    this.setThreadModelOverride(threadId, modelId);
    await this.channel.sendSystemMessage(
      roomId,
      `Set model override for ${threadId} to ${modelId}. It will be used on future turn starts.`
    );
  }

  /** Handles account read and account rate-limit subcommands. */
  private async handleAccountCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const subcommand = command.args[0]?.trim().toLowerCase();
    if (subcommand === "ratelimits" || subcommand === "rate-limits") {
      if (!this.latestAccountRateLimits) {
        await this.channel.sendSystemMessage(
          roomId,
          "No account rate-limit updates received yet. Send a request first, then try !account ratelimits again."
        );
        return;
      }

      await this.channel.sendJsonResponse(roomId, "Account rate limits", this.latestAccountRateLimits);
      return;
    }

    try {
      const result = await this.codexAppServer.accountRead({});
      await this.channel.sendJsonResponse(roomId, "Account response", result);
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to read account: ${String(error)}`);
      this.logWarn(`Failed to read account: ${String(error)}`);
    }
  }

  /** Shows or updates per-thread reasoning effort settings. */
  private async handleReasoningCommand(roomId: string, command: ControllerCommand): Promise<void> {
    const usage = "!reasoning [default|low|medium|high] [threadId]";
    const firstArg = command.args[0]?.trim();
    const firstArgLower = firstArg?.toLowerCase();

    if (!firstArgLower) {
      const mappedThreadId = this.roomThreadRoutes.get(roomId);
      if (!mappedThreadId) {
        await this.channel.sendSystemMessage(roomId, `No mapped thread for this room. Usage: ${usage}`);
        return;
      }

      const effort = this.getThreadState(mappedThreadId)?.reasoningEffort;
      const effectiveEffort = effort ?? "default";
      await this.channel.sendSystemMessage(
        roomId,
        `Effective next turn reasoning for ${mappedThreadId}: ${effectiveEffort}`
      );
      return;
    }

    const isValidEffort = firstArgLower === "low" || firstArgLower === "medium" || firstArgLower === "high";
    const isDefault = firstArgLower === "default";
    const isOff = firstArgLower === "off";

    if (!isValidEffort && !isDefault && !isOff) {
      const threadId = firstArg;
      const effort = this.getThreadState(threadId)?.reasoningEffort;
      const effectiveEffort = effort ?? "default";
      await this.channel.sendSystemMessage(
        roomId,
        `Effective next turn reasoning for ${threadId}: ${effectiveEffort}`
      );
      return;
    }

    const threadId = this.resolveThreadIdForCommand(roomId, command.args[1]?.trim(), usage);
    if (!threadId) {
      return;
    }

    if (isDefault || isOff) {
      this.setThreadReasoningEffort(threadId, undefined);
      await this.channel.sendSystemMessage(roomId, `Reasoning for ${threadId} reset to default.`);
      return;
    }

    this.setThreadReasoningEffort(threadId, firstArgLower);
    await this.channel.sendSystemMessage(roomId, `Reasoning for ${threadId} set to ${firstArgLower}.`);
  }

  /** Shows or updates tool-activity message verbosity for this bot instance. */
  private async handleVerbosityCommand(roomId: string, command: ControllerCommand): Promise<void> {
    const firstArg = command.args[0]?.trim().toLowerCase();

    if (!firstArg) {
      const status = this.toolActivityMessagesEnabled ? "on" : "off";
      await this.channel.sendSystemMessage(
        roomId,
        `Tool activity messages are ${status}. Approval requests are always shown.`
      );
      return;
    }

    if (firstArg !== "on" && firstArg !== "off") {
      await this.channel.sendSystemMessage(roomId, "Usage: !verbosity [on|off]");
      return;
    }

    this.toolActivityMessagesEnabled = firstArg === "on";
    this.persistThreadState();
    await this.channel.sendSystemMessage(
      roomId,
      firstArg === "on"
        ? "Tool activity messages enabled. Approval requests are always shown."
        : "Tool activity messages disabled. Approval requests are always shown."
    );
  }

  /** Creates, lists, and cancels schedule jobs for the mapped thread in this room. */
  private async handleScheduleCommand(roomId: string, command: ControllerCommand): Promise<void> {
    const subcommand = command.args[0]?.trim().toLowerCase();
    if (!subcommand) {
      await this.channel.sendSystemMessage(
        roomId,
        "Usage: !schedule <create|once|list|cancel> ..."
      );
      return;
    }

    if (subcommand === "list") {
      const activeJobs = this.stateDatabase.listActiveScheduleJobsByRoom(roomId);
      if (activeJobs.length === 0) {
        await this.channel.sendSystemMessage(roomId, "No active schedules for this room.");
        return;
      }

      const lines = activeJobs.map((scheduleJob) => {
        const runAtIso = new Date(scheduleJob.nextRunAtMs).toISOString();
        return `#${String(scheduleJob.id)} next ${runAtIso} [${scheduleJob.spec.timezone}] ${scheduleJob.spec.rrule} -> ${scheduleJob.message}`;
      });
      await this.channel.sendSystemMessage(roomId, `Active schedules:\n${lines.join("\n")}`);
      return;
    }

    if (subcommand === "cancel") {
      const idArg = command.args[1]?.trim();
      const id = idArg ? Number(idArg) : Number.NaN;
      if (!Number.isFinite(id) || id <= 0) {
        await this.channel.sendSystemMessage(roomId, "Usage: !schedule cancel <id>");
        return;
      }

      const wasCancelled = this.stateDatabase.cancelScheduleJob(roomId, Math.trunc(id));
      if (!wasCancelled) {
        await this.channel.sendSystemMessage(roomId, `No active schedule ${idArg} found for this room.`);
        return;
      }

      this.clearScheduledJobTimer(Math.trunc(id));
      await this.channel.sendSystemMessage(roomId, `Cancelled schedule #${idArg}.`);
      return;
    }

    if (subcommand !== "create" && subcommand !== "once") {
      await this.channel.sendSystemMessage(roomId, "Usage: !schedule <create|once|list|cancel> ...");
      return;
    }

    const threadId = this.roomThreadRoutes.get(roomId);
    if (!threadId) {
      await this.channel.sendSystemMessage(roomId, "No mapped thread for this room. Run !new or !resume first.");
      return;
    }

    try {
      let spec: ScheduleSpec;
      let messageText: string;
      if (subcommand === "once") {
        const dtstart = command.args[1]?.trim();
        messageText = command.args.slice(2).join(" ").trim();
        if (!dtstart || !messageText) {
          await this.channel.sendSystemMessage(roomId, "Usage: !schedule once <ISO-8601> <message>");
          return;
        }

        spec = normalizeScheduleSpec({
          version: "v1",
          timezone: "UTC",
          dtstart,
          rrule: "FREQ=DAILY;COUNT=1"
        });
      } else {
        const timezone = command.args[1]?.trim();
        const dtstart = command.args[2]?.trim();
        const rrule = command.args[3]?.trim();
        messageText = command.args.slice(4).join(" ").trim();
        if (!timezone || !dtstart || !rrule || !messageText) {
          await this.channel.sendSystemMessage(
            roomId,
            "Usage: !schedule create <timezone> <ISO-8601-dtstart> <RRULE> <message>"
          );
          return;
        }

        spec = normalizeScheduleSpec({
          version: "v1",
          timezone,
          dtstart,
          rrule
        });
      }

      const scheduleJob = this.createScheduleJobForRoom({
        roomId,
        threadId,
        message: messageText,
        spec
      });

      await this.channel.sendSystemMessage(
        roomId,
        `Scheduled #${String(scheduleJob.id)} next at ${new Date(scheduleJob.nextRunAtMs).toISOString()} [${scheduleJob.spec.timezone}] ${scheduleJob.spec.rrule}.`
      );
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to create schedule: ${String(error)}`);
    }
  }

  /** Starts the ChatGPT login flow and stores callback context for completion. */
  private async handleLoginCommand(roomId: string): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    try {
      const loginResult = await this.codexAppServer.accountLoginStart({
        type: "chatgpt"
      });
      const authUrl = getAuthUrlFromLoginResult(loginResult);

      if (!authUrl) {
        await this.channel.sendSystemMessage(roomId, "Login started, but no auth URL was returned.");
        return;
      }

      this.loginRoomId = roomId;
      this.pendingLoginRedirectUri = getRedirectUriFromAuthUrl(authUrl);

      await this.channel.sendSystemMessage(
        roomId,
        `Open this URL to sign in: ${authUrl}\nAfter approving, paste the full callback URL here using: !callback <callback-url>`
      );
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to start login: ${String(error)}`);
      this.logWarn(`Failed to start chatgpt login flow: ${String(error)}`);
    }
  }

  /** Accepts callback URL input and triggers login callback inside the runtime. */
  private async handleCallbackCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (!this.codexAppServer) {
      await this.channel.sendSystemMessage(roomId, "Codex app server is not configured.");
      return;
    }

    const callbackInput = command.args[0]?.trim();
    if (!callbackInput) {
      await this.channel.sendSystemMessage(roomId, "Usage: !callback <full-callback-url>");
      return;
    }

    const callbackUrl = normalizeCallbackUrl(callbackInput, this.pendingLoginRedirectUri);
    if (!callbackUrl) {
      await this.channel.sendSystemMessage(roomId, "Could not parse callback URL. Paste the full URL from your browser.");
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

        await this.channel.sendSystemMessage(
          roomId,
          `Callback accepted inside container (status ${response.status}). Waiting for login completion notification…`
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      await this.channel.sendSystemMessage(roomId, `Failed to trigger callback URL: ${String(error)}`);
      this.logWarn(`Failed to trigger callback URL: ${String(error)}`);
    }
  }

  /** Initializes Codex app-server protocol capabilities. */
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

  /** Restores persisted room-thread mappings by resuming each mapped thread. */
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

  /** Creates and arms a schedule job from a validated schedule spec. */
  private createScheduleJobForRoom(input: {
    roomId: string;
    threadId: string;
    message: string;
    spec: ScheduleSpec;
  }): ActiveScheduleJobRecord {
    const nextRunAtMs = computeNextScheduleRunAtMs(input.spec, Date.now());
    if (!Number.isFinite(nextRunAtMs)) {
      throw new Error("Schedule has no future occurrences.");
    }

    const scheduleJob = this.stateDatabase.createScheduleJob({
      roomId: input.roomId,
      threadId: input.threadId,
      message: input.message,
      spec: input.spec,
      nextRunAtMs: Math.trunc(nextRunAtMs as number)
    });
    this.registerScheduledJob(scheduleJob);
    return scheduleJob;
  }

  /** Restores active schedule jobs from SQLite and re-arms local timers. */
  private restoreScheduledMessages(): void {
    const activeJobs = this.stateDatabase.listAllActiveScheduleJobs();
    for (const activeJob of activeJobs) {
      this.registerScheduledJob(activeJob);
    }
    this.logInfo(`Restored ${String(activeJobs.length)} active schedule(s).`);
  }

  /** Registers a schedule job and arms its next timeout. */
  private registerScheduledJob(scheduleJob: ActiveScheduleJobRecord): void {
    this.clearScheduledJobTimer(scheduleJob.id);

    const delayMs = Math.max(0, scheduleJob.nextRunAtMs - Date.now());
    const timeout = setTimeout(() => {
      void this.executeScheduledJob(scheduleJob.id);
    }, delayMs);

    this.scheduledJobsById.set(scheduleJob.id, {
      ...scheduleJob,
      timeout
    });
  }

  /** Clears all active schedule timers. */
  private clearAllScheduledMessageTimers(): void {
    for (const [id] of this.scheduledJobsById.entries()) {
      this.clearScheduledJobTimer(id);
    }
  }

  /** Clears an active timer for a specific schedule id. */
  private clearScheduledJobTimer(id: number): void {
    const scheduleJob = this.scheduledJobsById.get(id);
    if (!scheduleJob) {
      return;
    }

    if (scheduleJob.timeout) {
      clearTimeout(scheduleJob.timeout);
    }

    this.scheduledJobsById.delete(id);
  }

  /** Executes one schedule occurrence by forwarding it into the target thread. */
  private async executeScheduledJob(id: number): Promise<void> {
    const scheduleJob = this.scheduledJobsById.get(id);
    if (!scheduleJob) {
      return;
    }

    this.clearScheduledJobTimer(id);
    const currentRunAtMs = scheduleJob.nextRunAtMs ?? Date.now();
    const nextRunAtMs = computeNextScheduleRunAtMs(scheduleJob.spec, currentRunAtMs + 1);

    if (!this.codexAppServer) {
      const errorText = "Codex app server is not configured.";
      const updatedJob = this.stateDatabase.advanceScheduleJobAfterRun({
        id,
        lastRunAtMs: currentRunAtMs,
        nextRunAtMs,
        lastError: errorText
      });
      if (updatedJob) {
        this.registerScheduledJob(updatedJob);
      }
      await this.channel.sendSystemMessage(
        scheduleJob.roomId,
        `Scheduled message #${String(id)} failed: ${errorText}`
      );
      return;
    }

    try {
      await this.sendUserMessageToThread(
        scheduleJob.roomId,
        scheduleJob.threadId,
        `[Scheduled message]\n${scheduleJob.message}`
      );
      const updatedJob = this.stateDatabase.advanceScheduleJobAfterRun({
        id,
        lastRunAtMs: currentRunAtMs,
        nextRunAtMs
      });
      if (updatedJob) {
        this.registerScheduledJob(updatedJob);
      }
      await this.channel.sendSystemMessage(
        scheduleJob.roomId,
        `Delivered scheduled message #${String(id)}.`
      );
    } catch (error) {
      const errorText = String(error);
      const updatedJob = this.stateDatabase.advanceScheduleJobAfterRun({
        id,
        lastRunAtMs: currentRunAtMs,
        nextRunAtMs,
        lastError: errorText
      });
      if (updatedJob) {
        this.registerScheduledJob(updatedJob);
      }
      await this.channel.sendSystemMessage(
        scheduleJob.roomId,
        `Scheduled message #${String(id)} failed: ${errorText}`
      );
    }
  }

  /** MCP handler for listing schedules. */
  private listSchedulesForMcp(roomId?: string): unknown {
    if (roomId?.trim()) {
      return this.stateDatabase.listActiveScheduleJobsByRoom(roomId.trim());
    }

    return this.stateDatabase.listAllActiveScheduleJobs();
  }

  /** MCP handler for creating schedules. */
  private async createScheduleForMcp(input: {
    roomId: string;
    message: string;
    spec: ScheduleSpec;
    threadId?: string;
  }): Promise<unknown> {
    const roomId = input.roomId.trim();
    if (!roomId) {
      throw new Error("roomId is required.");
    }

    const message = input.message.trim();
    if (!message) {
      throw new Error("message is required.");
    }

    const threadId = input.threadId?.trim() || this.roomThreadRoutes.get(roomId);
    if (!threadId) {
      throw new Error(`No mapped thread for room ${roomId}.`);
    }

    const spec = normalizeScheduleSpec(input.spec);
    return this.createScheduleJobForRoom({
      roomId,
      threadId,
      message,
      spec
    });
  }

  /** MCP handler for cancelling schedules. */
  private async cancelScheduleForMcp(roomId: string, id: number): Promise<unknown> {
    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId) {
      throw new Error("roomId is required.");
    }
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("id must be a positive integer.");
    }

    const normalizedId = Math.trunc(id);
    const cancelled = this.stateDatabase.cancelScheduleJob(normalizedRoomId, normalizedId);
    if (!cancelled) {
      return { cancelled: false, id: normalizedId };
    }

    this.clearScheduledJobTimer(normalizedId);
    return { cancelled: true, id: normalizedId };
  }

  /** Resolves a command thread id argument or falls back to the room mapping. */
  private resolveThreadIdForCommand(roomId: string, threadIdArg: string | undefined, usage: string): string | undefined {
    const threadId = threadIdArg || this.roomThreadRoutes.get(roomId);
    if (threadId) {
      return threadId;
    }

    void this.channel.sendSystemMessage(roomId, `No mapped thread for this room. Usage: ${usage}`);
    return undefined;
  }

  /** Updates in-memory token usage stats for a thread from payload data. */
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

    const existingUsage = this.getThreadState(threadId)?.tokenUsage ?? {};
    this.setThreadTokenUsage(threadId, {
      inputTokens: inputTokens ?? existingUsage.inputTokens,
      outputTokens: outputTokens ?? existingUsage.outputTokens,
      totalTokens: totalTokens ?? existingUsage.totalTokens,
      lastInputTokens: lastInputTokens ?? existingUsage.lastInputTokens,
      lastOutputTokens: lastOutputTokens ?? existingUsage.lastOutputTokens,
      lastTotalTokens: lastTotalTokens ?? existingUsage.lastTotalTokens
    });
  }

  /** Clears pending tool activity entries for a thread and optional turn. */
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

  /** Loads persisted state into in-memory maps. */
  private loadPersistedState(): void {
    const persistedState = this.stateDatabase.loadState();

    if (typeof persistedState.toolActivityMessagesEnabled === "boolean") {
      this.toolActivityMessagesEnabled = persistedState.toolActivityMessagesEnabled;
    }

    for (const [roomId, threadId] of persistedState.roomThreadRoutes.entries()) {
      this.roomThreadRoutes.set(roomId, threadId);
    }

    for (const [threadId, state] of persistedState.threadStateByThreadId.entries()) {
      this.threadStateByThreadId.set(threadId, state);
    }
  }

  /** Persists current room-thread routes to SQLite. */
  private persistRoomThreadRoutes(): void {
    this.stateDatabase.persistRoomThreadRoutes(this.roomThreadRoutes);
  }

  /** Persists per-thread state to SQLite. */
  private persistThreadState(): void {
    this.stateDatabase.persistThreadState({
      threadStateByThreadId: this.threadStateByThreadId,
      toolActivityMessagesEnabled: this.toolActivityMessagesEnabled
    });
  }

  /** Reads current thread state (without creating when absent). */
  private getThreadState(threadId: string): ThreadState | undefined {
    return this.threadStateByThreadId.get(threadId);
  }

  /** Ensures a thread state record exists and returns it. */
  private ensureThreadState(threadId: string): ThreadState {
    let state = this.threadStateByThreadId.get(threadId);
    if (state) {
      return state;
    }

    state = {};
    this.threadStateByThreadId.set(threadId, state);
    return state;
  }

  /** Drops empty thread-state records and persists when state mutates. */
  private finalizeThreadStateMutation(threadId: string): void {
    const state = this.threadStateByThreadId.get(threadId);
    if (!state) {
      this.persistThreadState();
      return;
    }

    const hasTokenUsage = state.tokenUsage !== undefined
      && Object.values(state.tokenUsage).some((value) => value !== undefined);

    const isEmpty =
      state.inFlightTurnId === undefined
      && state.pendingCompaction !== true
      && state.pendingInterruptTurnId === undefined
      && state.reasoningEffort === undefined
      && state.modelOverride === undefined
      && !hasTokenUsage;

    if (isEmpty) {
      this.threadStateByThreadId.delete(threadId);
    }

    this.persistThreadState();
  }

  private setThreadInFlightTurnId(threadId: string, turnId: string | undefined): void {
    const state = this.ensureThreadState(threadId);
    state.inFlightTurnId = turnId;
    this.finalizeThreadStateMutation(threadId);
  }

  private setThreadPendingCompaction(threadId: string, pendingCompaction: boolean): void {
    const state = this.ensureThreadState(threadId);
    state.pendingCompaction = pendingCompaction ? true : undefined;
    this.finalizeThreadStateMutation(threadId);
  }

  private setThreadPendingInterruptTurnId(threadId: string, turnId: string | undefined): void {
    const state = this.ensureThreadState(threadId);
    state.pendingInterruptTurnId = turnId;
    this.finalizeThreadStateMutation(threadId);
  }

  private setThreadReasoningEffort(threadId: string, reasoningEffort: ReasoningEffort | undefined): void {
    const state = this.ensureThreadState(threadId);
    state.reasoningEffort = reasoningEffort;
    this.finalizeThreadStateMutation(threadId);
  }

  private setThreadModelOverride(threadId: string, modelOverride: string | undefined): void {
    const state = this.ensureThreadState(threadId);
    state.modelOverride = modelOverride;
    this.finalizeThreadStateMutation(threadId);
  }

  private setThreadTokenUsage(threadId: string, tokenUsage: ThreadTokenUsage): void {
    const state = this.ensureThreadState(threadId);
    state.tokenUsage = tokenUsage;
    this.finalizeThreadStateMutation(threadId);
  }

  /** Writes info-level controller logs. */
  private logInfo(message: string): void {
    console.info("[slimebot]", message);
  }

  /** Writes warning-level controller logs. */
  private logWarn(message: string): void {
    console.warn("[slimebot]", message);
  }

  /** Writes error-level controller logs. */
  private logError(message: string): void {
    console.error("[slimebot]", message);
  }
}
