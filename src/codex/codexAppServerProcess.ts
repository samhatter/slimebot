import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

type CodexAppServerProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

export class CodexAppServerProcess extends EventEmitter {
  private readonly command: string;
  private readonly args: string[];
  private readonly options: CodexAppServerProcessOptions;
  private childProcess?: ChildProcessWithoutNullStreams;

  public constructor(command: string, args: string[] = [], options: CodexAppServerProcessOptions = {}) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
  }

  public get isRunning(): boolean {
    return Boolean(this.childProcess && !this.childProcess.killed);
  }

  public start(): void {
    if (this.childProcess) {
      return;
    }

    const child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.childProcess = child;
    this.emit("start", child.pid);

    const stdoutReader = createInterface({ input: child.stdout });
    stdoutReader.on("line", (line) => {
      this.emit("stdout", line);
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isJsonObject(parsed)) {
          this.emit("message", parsed);
        }
      } catch {
      }
    });

    const stderrReader = createInterface({ input: child.stderr });
    stderrReader.on("line", (line) => {
      this.emit("stderr", line);
    });

    child.on("error", (error) => {
      this.emit("error", error);
      this.childProcess = undefined;
      stdoutReader.close();
      stderrReader.close();
    });

    child.on("exit", (code, signal) => {
      this.emit("exit", code, signal);
      this.childProcess = undefined;
      stdoutReader.close();
      stderrReader.close();
    });
  }

  public send(payload: JsonObject): void {
    if (!this.childProcess || this.childProcess.killed) {
      throw new Error("Codex app server process is not running");
    }

    this.childProcess.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  public stop(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.childProcess || this.childProcess.killed) {
      return;
    }

    this.childProcess.kill(signal);
  }
}