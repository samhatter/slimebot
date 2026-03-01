import { LogService, MatrixClient } from "matrix-bot-sdk";
import { CodexAppServerProcess } from "./codexAppServerProcess.js";

type MatrixReplyMessage = {
  type: "matrix.reply";
  roomId: string;
  body: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMatrixReplyMessage(value: unknown): value is MatrixReplyMessage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value["type"] === "matrix.reply" &&
    typeof value["roomId"] === "string" &&
    typeof value["body"] === "string"
  );
}

export function registerCodexAppServerHandlers(
  codexAppServer: CodexAppServerProcess,
  client: MatrixClient
): void {
  codexAppServer.on("start", (pid: number) => {
    LogService.info("matrix-runner", `Codex app server started pid=${pid}`);
  });

  codexAppServer.on("stdout", (line: string) => {
    LogService.info("matrix-runner", `[codex.stdout] ${line}`);
  });

  codexAppServer.on("stderr", (line: string) => {
    LogService.warn("matrix-runner", `[codex.stderr] ${line}`);
  });

  codexAppServer.on("error", (error: Error) => {
    LogService.error("matrix-runner", `Codex app server error: ${String(error)}`);
  });

  codexAppServer.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    LogService.warn(
      "matrix-runner",
      `Codex app server exited code=${String(code)} signal=${String(signal)}`
    );
  });

  codexAppServer.on("message", async (message: unknown) => {
    if (!isMatrixReplyMessage(message)) {
      return;
    }

    try {
      await client.sendMessage(message.roomId, {
        msgtype: "m.text",
        body: message.body
      });
    } catch (error) {
      LogService.warn(
        "matrix-runner",
        `Failed to send Codex reply to room ${message.roomId}: ${String(error)}`
      );
    }
  });
}