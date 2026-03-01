import { LogService, MatrixClient } from "matrix-bot-sdk";
import { CodexAppServerProcess } from "../codex/codexAppServerProcess.js";
import type { CodexAppServerConfig } from "../codex/codexAppServerConfig.js";
import type { MatrixConfig } from "../matrix/matrixConfig.js";

type MatrixReplyMessage = {
  type: "matrix.reply";
  roomId: string;
  body: string;
};

type MatrixCommand = {
  name: string;
  args: string[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function isMatrixReplyMessage(value: unknown): value is MatrixReplyMessage {
  const record = asRecord(value);
  if (!record) {
    return false;
  }

  return (
    record["type"] === "matrix.reply" &&
    typeof record["roomId"] === "string" &&
    typeof record["body"] === "string"
  );
}

function parseMatrixCommand(body: string): MatrixCommand | undefined {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }

  const tokens = trimmed.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }

  const firstToken = tokens[0].startsWith("!") ? tokens[0].slice(1) : tokens[0];
  const commandName = firstToken.toLowerCase();
  if (commandName !== "login") {
    return undefined;
  }

  return {
    name: commandName,
    args: tokens.slice(1)
  };
}

function getAuthUrlFromLoginResult(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) {
    return undefined;
  }

  const authUrl = record["authUrl"];
  return typeof authUrl === "string" ? authUrl : undefined;
}

export class BotController {
  private readonly matrixClient: MatrixClient;
  private readonly codexAppServer?: CodexAppServerProcess;

  public constructor(
    private readonly matrixConfig: MatrixConfig,
    codexConfig: CodexAppServerConfig
  ) {
    this.matrixClient = new MatrixClient(matrixConfig.homeserverUrl, matrixConfig.accessToken);

    if (codexConfig.command) {
      this.codexAppServer = new CodexAppServerProcess(codexConfig.command, codexConfig.args);
    }
  }

  public async start(): Promise<void> {
    this.registerMatrixHandlers();
    this.registerCodexHandlers();
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

  private registerCodexHandlers(): void {
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

  private registerMatrixHandlers(): void {
    this.matrixClient.on("room.invite", async (roomId: string, event: unknown): Promise<void> => {
      const rawEvent = event as Record<string, unknown>;
      const sender = rawEvent["sender"] as string | undefined;
      if (!sender) {
        LogService.info("matrix-runner", `[room.invite] ignored room=${roomId} sender=unknown`);
        return;
      }

      if (this.matrixConfig.allowedInviteSender && sender !== this.matrixConfig.allowedInviteSender) {
        LogService.info(
          "matrix-runner",
          `[room.invite] ignored room=${roomId} sender=${sender} reason=sender_not_allowed allowed=${this.matrixConfig.allowedInviteSender}`
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
      const sender = rawEvent["sender"] as string | undefined;
      if (!sender || sender === this.matrixConfig.botUserId) {
        return;
      }

      const content = rawEvent["content"] as { body?: string; msgtype?: string } | undefined;
      if (!content || content.msgtype !== "m.text") {
        return;
      }

      const body = content.body ?? "";
      LogService.info("matrix-runner", `[room.message] room=${roomId} sender=${sender} body=${body}`);

      const command = parseMatrixCommand(body);
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
          originServerTs: rawEvent["origin_server_ts"]
        });
      } catch (error) {
        LogService.warn("matrix-runner", `Failed to forward Matrix message to Codex: ${String(error)}`);
      }
    });
  }

  private async handleCommand(roomId: string, command: MatrixCommand): Promise<void> {
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