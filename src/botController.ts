import { LogService, MatrixClient } from "matrix-bot-sdk";
import type { AppConfig } from "./appConfig.js";
import { CodexAppServerProcess } from "./codexAppServerProcess.js";
import { type ControllerCommand } from "./controllerCommands.js";
import { getAuthUrlFromLoginResult } from "./controllerParsers.js";
import { registerCodexEventHandlers } from "./codexEventHandlers.js";
import { registerMatrixEventHandlers } from "./matrixEventHandlers.js";

export class BotController {
  private readonly matrixClient: MatrixClient;
  private readonly codexAppServer?: CodexAppServerProcess;

  public constructor(private readonly appConfig: AppConfig) {
    this.matrixClient = new MatrixClient(appConfig.matrix.homeserverUrl, appConfig.matrix.accessToken);

    if (appConfig.codex.command) {
      this.codexAppServer = new CodexAppServerProcess(appConfig.codex.command, appConfig.codex.args);
    }
  }

  public async start(): Promise<void> {
    registerMatrixEventHandlers({
      matrixClient: this.matrixClient,
      matrixConfig: this.appConfig.matrix,
      codexAppServer: this.codexAppServer,
      handleCommand: this.handleCommand.bind(this)
    });

    if (this.codexAppServer) {
      registerCodexEventHandlers({
        codexAppServer: this.codexAppServer,
        sendTextMessage: this.sendTextMessage.bind(this)
      });
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