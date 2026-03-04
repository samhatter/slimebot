/**
 * @fileoverview Unix-socket HTTP client for the controller API server.
 */

import { request as httpRequest } from "node:http";

type JsonRecord = Record<string, unknown>;

async function requestJson(params: {
  socketPath: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
}): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const bodyText = params.body === undefined ? undefined : JSON.stringify(params.body);
    const req = httpRequest({
      socketPath: params.socketPath,
      method: params.method,
      path: params.path,
      headers: bodyText
        ? {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(bodyText)
          }
        : undefined
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const payload = text ? (JSON.parse(text) as unknown) : {};
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`Controller API error ${String(response.statusCode)}: ${text}`));
          return;
        }
        resolve(payload);
      });
    });

    req.on("error", reject);
    if (bodyText) {
      req.write(bodyText);
    }
    req.end();
  });
}

/** Thin client for controller socket API routes. */
export class ControllerApiClient {
  public constructor(private readonly socketPath: string) {}

  public async health(): Promise<unknown> {
    return requestJson({
      socketPath: this.socketPath,
      method: "GET",
      path: "/health"
    });
  }

  public async capabilities(): Promise<unknown> {
    return requestJson({
      socketPath: this.socketPath,
      method: "GET",
      path: "/capabilities"
    });
  }

  public async listSchedules(roomId?: string): Promise<unknown> {
    const query = roomId?.trim() ? `?roomId=${encodeURIComponent(roomId.trim())}` : "";
    return requestJson({
      socketPath: this.socketPath,
      method: "GET",
      path: `/schedules${query}`
    });
  }

  public async createSchedule(input: {
    roomId: string;
    message: string;
    runAtMs?: number;
    secondsFromNow?: number;
    threadId?: string;
  }): Promise<unknown> {
    return requestJson({
      socketPath: this.socketPath,
      method: "POST",
      path: "/schedules",
      body: input
    });
  }

  public async cancelSchedule(input: { roomId: string; id: number }): Promise<unknown> {
    const query = `?roomId=${encodeURIComponent(input.roomId)}`;
    return requestJson({
      socketPath: this.socketPath,
      method: "DELETE",
      path: `/schedules/${String(input.id)}${query}`
    });
  }

  public async sendThreadMessage(input: { roomId: string; threadId: string; message: string }): Promise<unknown> {
    return requestJson({
      socketPath: this.socketPath,
      method: "POST",
      path: `/threads/${encodeURIComponent(input.threadId)}/message`,
      body: {
        roomId: input.roomId,
        message: input.message
      }
    });
  }

  public async uploadMatrixFile(input: { roomId: string; filePath: string; caption?: string }): Promise<unknown> {
    const body: JsonRecord = {
      roomId: input.roomId,
      filePath: input.filePath
    };
    if (input.caption) {
      body.caption = input.caption;
    }

    return requestJson({
      socketPath: this.socketPath,
      method: "POST",
      path: "/channels/matrix/upload",
      body
    });
  }
}
