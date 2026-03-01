import { LogService, MatrixClient } from "matrix-bot-sdk";
import type { AppConfig } from "./appConfig.js";
import { CodexAppServerProcess } from "./codexAppServerProcess.js";
import { type ControllerCommand, parseControllerCommand } from "./controllerCommands.js";
import { getAuthUrlFromLoginResult, isMatrixReplyMessage } from "./controllerParsers.js";

export class BotController {
  private readonly matrixClient: MatrixClient;
  private readonly codexAppServer?: CodexAppServerProcess;
  private readonly processStartMs = Date.now();

  public constructor(private readonly appConfig: AppConfig) {
    this.matrixClient = new MatrixClient(appConfig.matrix.homeserverUrl, appConfig.matrix.accessToken);

    if (appConfig.codex.command) {
      this.codexAppServer = new CodexAppServerProcess(appConfig.codex.command, appConfig.codex.args);
    }
  }

  public async start(): Promise<void> {
    this.registerMatrixEventHandlers();

    if (this.codexAppServer) {
      this.registerCodexEventHandlers();
    }

    this.registerShutdownHandlers();

    this.codexAppServer?.start();
    await this.initializeCodexAppServer();

    await this.matrixClient.start();
    LogService.info("matrix-runner", "Bot runner started");
  }

  private registerShutdownHandlers(): void {
    const shutdown = (): void => {
      this.codexAppServer?.stop("SIGTERM");
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  private registerMatrixEventHandlers(): void {
    this.matrixClient.on("room.invite", async (roomId: string, event: unknown): Promise<void> => {
      const rawEvent = event as Record<string, unknown>;
      const sender = rawEvent["sender"] as string | undefined;
      if (!sender) {
        LogService.info("matrix-runner", `[room.invite] ignored room=${roomId} sender=unknown`);
        return;
      }

      if (this.appConfig.matrix.allowedInviteSender && sender !== this.appConfig.matrix.allowedInviteSender) {
        LogService.info(
          "matrix-runner",
          `[room.invite] ignored room=${roomId} sender=${sender} reason=sender_not_allowed allowed=${this.appConfig.matrix.allowedInviteSender}`
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
      if (!sender || sender === this.appConfig.matrix.botUserId) {
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
        await this.handleCommand(roomId, command);
        return;
      }

      if (!this.codexAppServer || !body) {
        return;
      }

      try {
        this.codexAppServer.send({
          type: "matrix.room.message",
          roomId,
          sender,
          body,
          originServerTs
        });
      } catch (error) {
        LogService.warn("matrix-runner", `Failed to forward Matrix message to Codex: ${String(error)}`);
      }
    });
  }

  private registerCodexEventHandlers(): void {
    if (!this.codexAppServer) {
      return;
    }

    this.codexAppServer.on("start", (pid: number) => {
      LogService.info("matrix-runner", `Codex app server started pid=${pid}`);
    });

    this.codexAppServer.on("stdout", (line: string) => {
      LogService.info("matrix-runner", `[codex.stdout] ${line}`);
    });

    this.codexAppServer.on("stderr", (line: string) => {
      LogService.warn("matrix-runner", `[codex.stderr] ${line}`);
    });

    this.codexAppServer.on("error", (error: Error) => {
      LogService.error("matrix-runner", `Codex app server error: ${String(error)}`);
    });

    this.codexAppServer.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      LogService.warn(
        "matrix-runner",
        `Codex app server exited code=${String(code)} signal=${String(signal)}`
      );
    });

    this.codexAppServer.on("message", async (message: unknown) => {
      if (!isMatrixReplyMessage(message)) {
        return;
      }

      try {
        await this.sendTextMessage(message.roomId, message.body);
      } catch (error) {
        LogService.warn(
          "matrix-runner",
          `Failed to send Codex reply to room ${message.roomId}: ${String(error)}`
        );
      }
    });
  }

  private async handleCommand(roomId: string, command: ControllerCommand): Promise<void> {
    if (command.name !== "login") {
      return;
    }

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

      await this.sendTextMessage(roomId, `Open this URL to sign in: ${authUrl}`);
    } catch (error) {
      await this.sendTextMessage(roomId, `Failed to start login: ${String(error)}`);
      LogService.warn("matrix-runner", `Failed to start chatgpt login flow: ${String(error)}`);
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
        }
      });
      LogService.info("matrix-runner", "Codex app server initialized");
    } catch (error) {
      LogService.warn("matrix-runner", `Failed to initialize Codex app server: ${String(error)}`);
    }
  }

  private async sendTextMessage(roomId: string, body: string): Promise<void> {
    await this.matrixClient.sendMessage(roomId, {
      msgtype: "m.text",
      body
    });
  }
}