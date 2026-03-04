/**
 * @fileoverview Native MCP stdio server that proxies controller capabilities over Unix socket API.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ControllerApiClient } from "./controllerApiClient.js";

const DEFAULT_SOCKET_PATH = "/var/lib/slimebot/workspace/slimebot-controller.sock";
const socketPath = process.env.SLIMEBOT_CONTROLLER_API_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
const apiClient = new ControllerApiClient(socketPath);

const server = new McpServer({
  name: "slimebot-controller-mcp",
  version: "0.1.0"
});

function asToolText(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

server.registerTool(
  "controller_health",
  {
    title: "Controller Health",
    description: "Check that the Slimebot controller API socket is reachable."
  },
  async () => asToolText(await apiClient.health())
);

server.registerTool(
  "controller_capabilities",
  {
    title: "Controller Capabilities",
    description: "List capabilities exposed by the Slimebot controller API."
  },
  async () => asToolText(await apiClient.capabilities())
);

server.registerTool(
  "schedule_list",
  {
    title: "List Schedules",
    description: "List pending schedules. Optionally scope by roomId.",
    inputSchema: {
      roomId: z.string().optional()
    }
  },
  async (args) => asToolText(await apiClient.listSchedules(args.roomId))
);

server.registerTool(
  "schedule_create",
  {
    title: "Create Schedule",
    description: "Create a pending scheduled message for a room/thread.",
    inputSchema: {
      roomId: z.string(),
      message: z.string(),
      runAtMs: z.number().optional(),
      secondsFromNow: z.number().optional(),
      threadId: z.string().optional()
    }
  },
  async (args) => asToolText(await apiClient.createSchedule(args))
);

server.registerTool(
  "schedule_cancel",
  {
    title: "Cancel Schedule",
    description: "Cancel a pending schedule by id and roomId.",
    inputSchema: {
      roomId: z.string(),
      id: z.number()
    }
  },
  async (args) => asToolText(await apiClient.cancelSchedule({ roomId: args.roomId, id: Math.trunc(args.id) }))
);

server.registerTool(
  "thread_send_message",
  {
    title: "Send Thread Message",
    description: "Send a text message into a specific thread in a specific room.",
    inputSchema: {
      roomId: z.string(),
      threadId: z.string(),
      message: z.string()
    }
  },
  async (args) => asToolText(await apiClient.sendThreadMessage(args))
);

server.registerTool(
  "matrix_upload_file",
  {
    title: "Upload Matrix File",
    description: "Upload a local workspace file to a Matrix room.",
    inputSchema: {
      roomId: z.string(),
      filePath: z.string(),
      caption: z.string().optional()
    }
  },
  async (args) => asToolText(await apiClient.uploadMatrixFile(args))
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal MCP server startup error", error);
  process.exit(1);
});
