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

export class BotController {
  private readonly channel: Channel;
  private readonly codexAppServer?: CodexAppServerProcess;
  private readonly routingPersistencePath: string;
  private readonly roomThreadRoutes = new Map<string, string>();
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

      try {
        await this.codexAppServer.turnStart({
          threadId,
          input: [
            {
              type: "text",
              text: body
            }
          ]
        });
      } catch (error) {
        this.logWarn(`Failed to send message to Codex thread ${threadId}: ${String(error)}`);
      }
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
    if (command.name === "help") {
      await this.handleHelpCommand(roomId);
      return;
    }

    if (command.name === "new") {
      await this.handleNewCommand(roomId);
      return;
    }

    if (command.name === "login") {
      await this.handleLoginCommand(roomId);
      return;
    }

    if (command.name === "callback") {
      await this.handleCallbackCommand(roomId, command);
      return;
    }

    if (command.name === "models") {
      await this.handleModelsCommand(roomId);
      return;
    }

    if (command.name === "account") {
      await this.handleAccountCommand(roomId);
    }
  }

  private async handleHelpCommand(roomId: string): Promise<void> {
    await this.sendTextMessage(
      roomId,
      [
        "Available commands:",
        "- !help: Show this command list",
        "- !new: Create and map a new Codex thread for this room",
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
