import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

type CodexAppServerProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type JsonObject = Record<string, unknown>;

type JsonRpcId = number | string;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: JsonObject;
};

type JsonRpcNotification = {
  method: string;
  params?: JsonObject;
};

type JsonRpcSuccessResponse = {
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcErrorResponse = {
  id: JsonRpcId;
  error: JsonRpcError;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timeout?: NodeJS.Timeout;
};

type InitializeParams = {
  clientInfo: {
    name: string;
    title?: string;
    version: string;
  };
  capabilities?: JsonObject;
};

type RequestOptions = {
  timeoutMs?: number;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  return (
    isJsonObject(value) &&
    typeof value["code"] === "number" &&
    typeof value["message"] === "string"
  );
}

export class CodexAppServerProcess extends EventEmitter {
  private readonly command: string;
  private readonly args: string[];
  private readonly options: CodexAppServerProcessOptions;
  private childProcess?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private initialized = false;

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
          this.handleIncomingMessage(parsed);
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
      this.rejectAllPendingRequests(error);
      this.initialized = false;
      this.childProcess = undefined;
      stdoutReader.close();
      stderrReader.close();
    });

    child.on("exit", (code, signal) => {
      this.emit("exit", code, signal);
      this.rejectAllPendingRequests(new Error(`Codex app server exited code=${String(code)} signal=${String(signal)}`));
      this.initialized = false;
      this.childProcess = undefined;
      stdoutReader.close();
      stderrReader.close();
    });
  }

  public async initialize(params: InitializeParams, requestOptions: RequestOptions = {}): Promise<unknown> {
    if (this.initialized) {
      return undefined;
    }

    const result = await this.request("initialize", params, requestOptions);
    this.sendNotification("initialized", {});
    this.initialized = true;
    return result;
  }

  public sendNotification(method: string, params?: JsonObject): void {
    const payload: JsonRpcNotification = params ? { method, params } : { method };
    this.send(payload);
  }

  public request<T = unknown>(method: string, params?: JsonObject, options: RequestOptions = {}): Promise<T> {
    if (!this.childProcess || this.childProcess.killed) {
      throw new Error("Codex app server process is not running");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const payload: JsonRpcRequest = params ? { id, method, params } : { id, method };

    return new Promise<T>((resolve, reject) => {
      const pendingRequest: PendingRequest = {
        resolve: (value: unknown) => {
          resolve(value as T);
        },
        reject
      };

      const timeoutMs = options.timeoutMs ?? 120_000;
      if (timeoutMs > 0) {
        pendingRequest.timeout = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Codex app server request timed out method=${method} id=${String(id)}`));
        }, timeoutMs);
      }

      this.pendingRequests.set(id, pendingRequest);
      this.send(payload);
    });
  }

  public respondSuccess(id: JsonRpcId, result: unknown = {}): void {
    this.send({ id, result });
  }

  public respondError(id: JsonRpcId, error: JsonRpcError): void {
    this.send({ id, error });
  }

  public send(payload: JsonObject): void {
    if (!this.childProcess || this.childProcess.killed) {
      throw new Error("Codex app server process is not running");
    }

    const wirePayload = Object.hasOwn(payload, "jsonrpc")
      ? payload
      : { jsonrpc: "2.0", ...payload };

    this.childProcess.stdin.write(`${JSON.stringify(wirePayload)}\n`);
  }

  public stop(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.childProcess || this.childProcess.killed) {
      return;
    }

    this.childProcess.kill(signal);
  }

  private handleIncomingMessage(message: JsonObject): void {
    this.emit("message", message);

    if (
      isJsonRpcId(message["id"]) &&
      Object.hasOwn(message, "result") &&
      !Object.hasOwn(message, "method")
    ) {
      this.handleRpcSuccessResponse({
        id: message["id"],
        result: message["result"]
      });
      return;
    }

    if (
      isJsonRpcId(message["id"]) &&
      isJsonRpcError(message["error"]) &&
      !Object.hasOwn(message, "method")
    ) {
      this.handleRpcErrorResponse({
        id: message["id"],
        error: message["error"]
      });
      return;
    }

    if (typeof message["method"] === "string" && isJsonRpcId(message["id"])) {
      const method = message["method"];
      const params = isJsonObject(message["params"]) ? message["params"] : undefined;
      this.emit("request", message["id"], method, params, message);
      this.emit(`request:${method}`, message["id"], params, message);
      return;
    }

    if (typeof message["method"] === "string") {
      const method = message["method"];
      const params = isJsonObject(message["params"]) ? message["params"] : undefined;
      this.emit("notification", method, params, message);
      this.emit(`notification:${method}`, params, message);
    }
  }

  private handleRpcSuccessResponse(response: JsonRpcSuccessResponse): void {
    const pendingRequest = this.pendingRequests.get(response.id);
    if (!pendingRequest) {
      return;
    }

    this.pendingRequests.delete(response.id);
    if (pendingRequest.timeout) {
      clearTimeout(pendingRequest.timeout);
    }

    pendingRequest.resolve(response.result);
    this.emit("response", response.id, response.result);
  }

  private handleRpcErrorResponse(response: JsonRpcErrorResponse): void {
    const pendingRequest = this.pendingRequests.get(response.id);
    if (!pendingRequest) {
      return;
    }

    this.pendingRequests.delete(response.id);
    if (pendingRequest.timeout) {
      clearTimeout(pendingRequest.timeout);
    }

    const error = new Error(response.error.message);
    pendingRequest.reject(error);
    this.emit("rpcError", response.id, response.error);
  }

  private rejectAllPendingRequests(error: Error): void {
    for (const [id, pendingRequest] of this.pendingRequests.entries()) {
      if (pendingRequest.timeout) {
        clearTimeout(pendingRequest.timeout);
      }

      pendingRequest.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  public threadStart(params: JsonObject = {}): Promise<unknown> {
    return this.request("thread/start", params);
  }

  public threadResume(params: JsonObject): Promise<unknown> {
    return this.request("thread/resume", params);
  }

  public threadList(params: JsonObject = {}): Promise<unknown> {
    return this.request("thread/list", params);
  }

  public threadRead(params: JsonObject): Promise<unknown> {
    return this.request("thread/read", params);
  }

  public threadArchive(params: JsonObject): Promise<unknown> {
    return this.request("thread/archive", params);
  }

  public threadUnarchive(params: JsonObject): Promise<unknown> {
    return this.request("thread/unarchive", params);
  }

  public threadCompactStart(params: JsonObject): Promise<unknown> {
    return this.request("thread/compact/start", params);
  }

  public threadRollback(params: JsonObject): Promise<unknown> {
    return this.request("thread/rollback", params);
  }

  public turnStart(params: JsonObject): Promise<unknown> {
    return this.request("turn/start", params);
  }

  public turnSteer(params: JsonObject): Promise<unknown> {
    return this.request("turn/steer", params);
  }

  public turnInterrupt(params: JsonObject): Promise<unknown> {
    return this.request("turn/interrupt", params);
  }

  public reviewStart(params: JsonObject): Promise<unknown> {
    return this.request("review/start", params);
  }

  public commandExec(params: JsonObject): Promise<unknown> {
    return this.request("command/exec", params);
  }

  public modelList(params: JsonObject = {}): Promise<unknown> {
    return this.request("model/list", params);
  }

  public accountRead(params: JsonObject = {}): Promise<unknown> {
    return this.request("account/read", params);
  }

  public accountLoginStart(params: JsonObject): Promise<unknown> {
    return this.request("account/login/start", params);
  }
}