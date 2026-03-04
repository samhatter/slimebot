/**
 * @fileoverview Thin stdio <-> unix-socket bridge for the controller MCP server.
 */

import process from "node:process";
import { createConnection } from "node:net";

const DEFAULT_SOCKET_PATH = "/var/lib/slimebot/workspace/slimebot-controller.sock";
const socketPath = process.env.SLIMEBOT_CONTROLLER_MCP_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;

function logError(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  const socket = createConnection(socketPath);

  socket.on("connect", () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });

  socket.on("error", (error) => {
    logError(`Failed to connect to controller MCP socket ${socketPath}: ${String(error)}`);
    process.exitCode = 1;
  });

  socket.on("close", (hadError) => {
    process.stdin.unpipe(socket);
    socket.unpipe(process.stdout);
    if (hadError) {
      process.exitCode = process.exitCode || 1;
    }
    process.exit();
  });

  process.on("SIGINT", () => {
    socket.end();
  });
  process.on("SIGTERM", () => {
    socket.end();
  });
}

void main();
