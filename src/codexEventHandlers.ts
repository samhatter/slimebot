import { LogService } from "matrix-bot-sdk";
import { CodexAppServerProcess } from "./codexAppServerProcess.js";
import { isMatrixReplyMessage } from "./controllerParsers.js";

type CodexEventHandlerDependencies = {
  codexAppServer: CodexAppServerProcess;
  sendTextMessage: (roomId: string, body: string) => Promise<void>;
};

export function registerCodexEventHandlers(dependencies: CodexEventHandlerDependencies): void {
  dependencies.codexAppServer.on("start", (pid: number) => {
    LogService.info("matrix-runner", `Codex app server started pid=${pid}`);
  });

  dependencies.codexAppServer.on("stdout", (line: string) => {
    LogService.info("matrix-runner", `[codex.stdout] ${line}`);
  });

  dependencies.codexAppServer.on("stderr", (line: string) => {
    LogService.warn("matrix-runner", `[codex.stderr] ${line}`);
  });

  dependencies.codexAppServer.on("error", (error: Error) => {
    LogService.error("matrix-runner", `Codex app server error: ${String(error)}`);
  });

  dependencies.codexAppServer.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    LogService.warn(
      "matrix-runner",
      `Codex app server exited code=${String(code)} signal=${String(signal)}`
    );
  });

  dependencies.codexAppServer.on("message", async (message: unknown) => {
    if (!isMatrixReplyMessage(message)) {
      return;
    }

    try {
      await dependencies.sendTextMessage(message.roomId, message.body);
    } catch (error) {
      LogService.warn(
        "matrix-runner",
        `Failed to send Codex reply to room ${message.roomId}: ${String(error)}`
      );
    }
  });
}