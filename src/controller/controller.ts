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

export class BotController {
  private readonly channel: Channel;
  private readonly codexAppServer?: CodexAppServerProcess;
  private readonly routingPersistencePath: string;
  private readonly roomThreadRoutes = new Map<string, string>();
  private readonly inFlightTurnByThreadId = new Map<string, string>();
  private readonly pendingCompactionByThreadId = new Set<string>();
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

    this.codexAppServer.on("notification:turn/completed", (params: unknown) => {
      const record = asRecord(params);
      const turn = asRecord(record?.["turn"]);
      const threadId = this.readStringFromAny(record?.["threadId"], turn?.["threadId"]);
      const turnId = this.readStringFromAny(record?.["turnId"], turn?.["id"]);

      if (!threadId) {
        return;
      }

      const currentTurnId = this.inFlightTurnByThreadId.get(threadId);
      if (!currentTurnId) {
        return;
      }

      if (!turnId || currentTurnId === turnId) {
        this.inFlightTurnByThreadId.delete(threadId);
      }
    });

    this.codexAppServer.on("notification:thread/compacted", async (params: unknown) => {
      const record = asRecord(params);
      const threadId = this.readStringFromAny(record?.["threadId"]);
      if (!threadId || !this.pendingCompactionByThreadId.has(threadId)) {
        return;
      }

      this.pendingCompactionByThreadId.delete(threadId);
      const roomId = this.getRoomIdByThreadId(threadId);
      if (!roomId) {
        return;
      }

      const turnId = this.readStringFromAny(record?.["turnId"]);
      await this.sendTextMessage(
        roomId,
        turnId
          ? `Compaction completed for ${threadId} (turn ${turnId}).`
          : `Compaction completed for ${threadId}.`
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

    await this.sendTextMessage(
      roomId,
      [
        `Approval requested for ${approvalType}.`,
        `- threadId: ${threadId}`,
        `- turnId: ${turnId}`,
        `- itemId: ${itemId}`,
        commandPreview ? `- command: ${commandPreview}` : undefined,
        reason ? `- reason: ${reason}` : undefined,
        "Reply with !approve (!a) to approve, or !skip (!s) to decline."
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n")
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
    await this.sendTextMessage(
      roomId,
      [
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
      ].join("\n")
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
      await this.sendTextMessage(roomId, this.formatThreadList(result, archived));
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

    try {
      await this.codexAppServer.turnInterrupt({ threadId, turnId });
      await this.sendTextMessage(roomId, `Interrupt requested for turn ${turnId}.`);
    } catch (error) {
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
      await this.sendTextMessage(roomId, `Model response:\n${this.stringifyJson(result)}`);
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
      await this.sendTextMessage(roomId, `Account response:\n${this.stringifyJson(result)}`);
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

  private formatThreadList(result: unknown, archived: boolean): string {
    const record = asRecord(result);
    const data = record?.["data"];
    if (!Array.isArray(data) || data.length === 0) {
      return archived ? "No archived threads found." : "No threads found.";
    }

    const lines = data
      .slice(0, 20)
      .map((item, index) => {
        const entry = asRecord(item);
        const threadId = this.readStringFromAny(entry?.["id"]) ?? "<unknown>";
        const name = this.readStringFromAny(entry?.["name"]);
        const preview = this.readStringFromAny(entry?.["preview"]);
        const updatedAt = this.readStringFromAny(entry?.["updatedAt"], entry?.["createdAt"]);

        return [
          `${index + 1}. ${threadId}`,
          name ? `   name: ${name}` : undefined,
          preview ? `   preview: ${preview}` : undefined,
          updatedAt ? `   updatedAt: ${updatedAt}` : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n");
      })
      .join("\n");

    return `${archived ? "Archived" : "Active"} threads:\n${lines}`;
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

  private async sendTextMessage(roomId: string, body: string): Promise<void> {
    await this.channel.sendTextMessage(roomId, new ChannelOutboundMessage({ body }));
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
