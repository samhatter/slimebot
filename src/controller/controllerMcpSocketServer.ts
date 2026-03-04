/**
 * @fileoverview Controller-owned MCP server exposed on a Unix domain socket.
 */

import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ChannelMcpToolDefinition } from "../channels/channel.js";

type McpHandlers = {
  listSchedules: (roomId?: string) => unknown;
  createSchedule: (input: {
    roomId: string;
    message: string;
    spec: {
      version: "v1";
      timezone: string;
      dtstart: string;
      rrule: string;
    };
    threadId?: string;
  }) => Promise<unknown>;
  cancelSchedule: (roomId: string, id: number) => Promise<unknown>;
};

function serializeJsonRpc(message: JSONRPCMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function parseJsonRpc(line: string): JSONRPCMessage {
  return JSON.parse(line) as JSONRPCMessage;
}

function toToolTextResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

class SocketLineTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  private readBuffer = Buffer.alloc(0);
  private started = false;

  public constructor(private readonly socket: Socket) {}

  public async start(): Promise<void> {
    if (this.started) {
      throw new Error("SocketLineTransport already started");
    }
    this.started = true;
    this.socket.on("data", this.onData);
    this.socket.on("error", this.onSocketError);
    this.socket.on("close", this.onSocketClose);
  }

  public async send(message: JSONRPCMessage): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const payload = serializeJsonRpc(message);
      this.socket.write(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  public async close(): Promise<void> {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onSocketError);
    this.socket.off("close", this.onSocketClose);
    this.readBuffer = Buffer.alloc(0);
    if (!this.socket.destroyed) {
      this.socket.end();
    }
    this.onclose?.();
  }

  private readonly onData = (chunk: Buffer): void => {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

    while (true) {
      const newlineIndex = this.readBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = this.readBuffer.toString("utf8", 0, newlineIndex).replace(/\r$/, "");
      this.readBuffer = this.readBuffer.subarray(newlineIndex + 1);
      if (!line.trim()) {
        continue;
      }

      try {
        this.onmessage?.(parseJsonRpc(line));
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  private readonly onSocketError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly onSocketClose = (): void => {
    this.onclose?.();
  };
}

/**
 * MCP server that listens on a Unix socket for controller + channel tools.
 */
export class ControllerMcpSocketServer {
  private readonly server: NetServer;
  private started = false;
  private readonly sockets = new Set<Socket>();

  public constructor(
    private readonly socketPath: string,
    private readonly handlers: McpHandlers,
    private readonly channelToolDefinitions: readonly ChannelMcpToolDefinition[],
    private readonly logInfo: (message: string) => void,
    private readonly logWarn: (message: string) => void
  ) {
    this.server = createServer(this.onConnection);
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    try {
      await unlink(this.socketPath);
    } catch {
      // ignore stale/missing socket cleanup errors
    }

    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    try {
      await chmod(this.socketPath, 0o660);
    } catch (error) {
      this.logWarn(`Failed to chmod MCP socket ${this.socketPath}: ${String(error)}`);
    }

    this.started = true;
    this.logInfo(`Controller MCP server listening on unix://${this.socketPath}`);
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    for (const socket of this.sockets) {
      socket.end();
      socket.destroy();
    }
    this.sockets.clear();

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

  private readonly onConnection = (socket: Socket): void => {
    this.sockets.add(socket);
    socket.once("close", () => {
      this.sockets.delete(socket);
    });

    const transport = new SocketLineTransport(socket);
    const mcpServer = this.createMcpServer();
    void mcpServer.connect(transport).catch((error) => {
      this.logWarn(`Failed to attach MCP socket transport: ${String(error)}`);
      socket.destroy();
    });
  };

  private createMcpServer(): McpServer {
    const server = new McpServer({
      name: "slimebot-controller",
      version: "0.1.0"
    });

    server.registerTool(
      "schedule_list",
      {
        title: "List Schedules",
        description: "List active schedules, optionally scoped to a room.",
        inputSchema: {
          roomId: z.string().optional()
        }
      },
      async (args) => toToolTextResult(this.handlers.listSchedules(args.roomId))
    );

    server.registerTool(
      "schedule_create",
      {
        title: "Create Schedule",
        description: "Create a schedule in a room using a unified schedule spec.",
        inputSchema: {
          roomId: z.string(),
          message: z.string(),
          spec: z.object({
            version: z.literal("v1"),
            timezone: z.string(),
            dtstart: z.string(),
            rrule: z.string()
          }),
          threadId: z.string().optional()
        }
      },
      async (args) => toToolTextResult(await this.handlers.createSchedule(args))
    );

    server.registerTool(
      "schedule_cancel",
      {
        title: "Cancel Schedule",
        description: "Cancel a pending schedule by roomId and id.",
        inputSchema: {
          roomId: z.string(),
          id: z.number()
        }
      },
      async (args) => toToolTextResult(await this.handlers.cancelSchedule(args.roomId, Math.trunc(args.id)))
    );

    const registeredToolNames = new Set<string>(["schedule_list", "schedule_create", "schedule_cancel"]);
    for (const toolDefinition of this.channelToolDefinitions) {
      if (registeredToolNames.has(toolDefinition.name)) {
        this.logWarn(`Skipping duplicate MCP tool name from channel: ${toolDefinition.name}`);
        continue;
      }

      registeredToolNames.add(toolDefinition.name);
      server.registerTool(
        toolDefinition.name,
        {
          title: toolDefinition.title,
          description: toolDefinition.description,
          inputSchema: toolDefinition.inputSchema
        },
        async (args) => toToolTextResult(await toolDefinition.execute(args as Record<string, unknown>))
      );
    }

    return server;
  }
}
