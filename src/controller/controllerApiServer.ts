/**
 * @fileoverview Unix-socket HTTP API server for controller-owned capabilities and events.
 */

import { chmod, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

type ApiHandlers = {
  listSchedules: (roomId?: string) => unknown;
  createSchedule: (input: {
    roomId: string;
    message: string;
    runAtMs?: number;
    secondsFromNow?: number;
    threadId?: string;
  }) => Promise<unknown>;
  cancelSchedule: (roomId: string, id: number) => Promise<unknown>;
  sendThreadMessage: (input: { roomId: string; threadId: string; message: string }) => Promise<unknown>;
  uploadMatrixFile: (input: { roomId: string; filePath: string; caption?: string }) => Promise<unknown>;
  getCapabilities: () => unknown;
  getOpenApiSpec: () => unknown;
};

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("JSON body must be an object.");
  }

  return parsed as Record<string, unknown>;
}

/**
 * Lightweight HTTP API server bound to a Unix domain socket.
 */
export class ControllerApiServer extends EventEmitter {
  private readonly sseClients = new Set<ServerResponse>();
  private readonly server = createServer(this.handleRequest.bind(this));
  private started = false;

  public constructor(
    private readonly socketPath: string,
    private readonly handlers: ApiHandlers,
    private readonly logInfo: (message: string) => void,
    private readonly logWarn: (message: string) => void
  ) {
    super();
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    try {
      await unlink(this.socketPath);
    } catch {
      // ignore missing or non-removable stale socket
    }

    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    try {
      await chmod(this.socketPath, 0o666);
    } catch (error) {
      this.logWarn(`Failed to chmod socket ${this.socketPath}: ${String(error)}`);
    }

    this.started = true;
    this.logInfo(`Controller API listening on unix://${this.socketPath}`);
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    for (const response of this.sseClients) {
      response.end();
    }
    this.sseClients.clear();

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });

    try {
      await unlink(this.socketPath);
    } catch {
      // ignore cleanup failures
    }

    this.started = false;
  }

  public emitEvent(eventType: string, payload: unknown): void {
    const event = {
      event: eventType,
      ts: new Date().toISOString(),
      payload
    };

    this.emit("event", event);

    const body = `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of this.sseClients) {
      response.write(body);
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method?.toUpperCase() ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (method === "GET" && path === "/health") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (method === "GET" && path === "/capabilities") {
        writeJson(response, 200, this.handlers.getCapabilities());
        return;
      }

      if (method === "GET" && path === "/openapi.json") {
        writeJson(response, 200, this.handlers.getOpenApiSpec());
        return;
      }

      if (method === "GET" && path === "/events") {
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("cache-control", "no-cache");
        response.setHeader("connection", "keep-alive");
        response.write(": connected\n\n");
        this.sseClients.add(response);
        request.on("close", () => {
          this.sseClients.delete(response);
        });
        return;
      }

      if (method === "GET" && path === "/schedules") {
        const roomId = url.searchParams.get("roomId") ?? undefined;
        writeJson(response, 200, this.handlers.listSchedules(roomId));
        return;
      }

      if (method === "POST" && path === "/schedules") {
        const body = await readJsonBody(request);
        if (typeof body.roomId !== "string" || typeof body.message !== "string") {
          writeJson(response, 400, { error: "roomId and message are required string fields." });
          return;
        }
        const result = await this.handlers.createSchedule({
          roomId: body.roomId,
          message: body.message,
          runAtMs: typeof body.runAtMs === "number" ? body.runAtMs : undefined,
          secondsFromNow: typeof body.secondsFromNow === "number" ? body.secondsFromNow : undefined,
          threadId: typeof body.threadId === "string" ? body.threadId : undefined
        });
        writeJson(response, 200, result);
        return;
      }

      if (method === "DELETE" && path.startsWith("/schedules/")) {
        const id = Number(path.slice("/schedules/".length));
        const roomId = url.searchParams.get("roomId");
        if (!Number.isFinite(id) || !roomId) {
          writeJson(response, 400, { error: "schedule id and roomId query parameter are required." });
          return;
        }
        const result = await this.handlers.cancelSchedule(roomId, Math.trunc(id));
        writeJson(response, 200, result);
        return;
      }

      const threadMessageMatch = /^\/threads\/([^/]+)\/message$/.exec(path);
      if (method === "POST" && threadMessageMatch) {
        const body = await readJsonBody(request);
        if (typeof body.roomId !== "string" || typeof body.message !== "string") {
          writeJson(response, 400, { error: "roomId and message are required string fields." });
          return;
        }
        const threadId = decodeURIComponent(threadMessageMatch[1]);
        const result = await this.handlers.sendThreadMessage({
          roomId: body.roomId,
          threadId,
          message: body.message
        });
        writeJson(response, 200, result);
        return;
      }

      if (method === "POST" && path === "/channels/matrix/upload") {
        const body = await readJsonBody(request);
        if (typeof body.roomId !== "string" || typeof body.filePath !== "string") {
          writeJson(response, 400, { error: "roomId and filePath are required string fields." });
          return;
        }
        const result = await this.handlers.uploadMatrixFile({
          roomId: body.roomId,
          filePath: body.filePath,
          caption: typeof body.caption === "string" ? body.caption : undefined
        });
        writeJson(response, 200, result);
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, 500, { error: String(error) });
    }
  }
}
