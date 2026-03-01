import { LogService, MatrixClient } from "matrix-bot-sdk";
import { CodexAppServerProcess } from "./codex/codexAppServerProcess.js";
import { loadCodexAppServerConfig } from "./codex/codexAppServerConfig.js";
import { registerCodexAppServerHandlers } from "./codex/codexAppServerHandlers.js";
import {
	createMatrixRoomInviteHandler,
	createMatrixRoomMessageHandler
} from "./matrix/matrixClientHandlers.js";
import { loadMatrixConfig } from "./matrix/matrixConfig.js";

function createCodexAppServer(command: string | undefined, args: string[]): CodexAppServerProcess | undefined {
	if (!command) {
		return undefined;
	}

	return new CodexAppServerProcess(command, args);
}

function registerMatrixClientHandlers(
	client: MatrixClient,
	matrixConfig: ReturnType<typeof loadMatrixConfig>,
	codexAppServer: CodexAppServerProcess | undefined
): void {
	client.on(
		"room.invite",
		createMatrixRoomInviteHandler({
			client,
			allowedInviteSender: matrixConfig.allowedInviteSender
		})
	);

	client.on(
		"room.message",
		createMatrixRoomMessageHandler({
			botUserId: matrixConfig.botUserId,
			codexAppServer
		})
	);
}

function registerShutdownHandlers(codexAppServer: CodexAppServerProcess | undefined): void {
	const shutdownCodexServer = (): void => {
		codexAppServer?.stop("SIGTERM");
	};

	process.once("SIGINT", shutdownCodexServer);
	process.once("SIGTERM", shutdownCodexServer);
}

async function main(): Promise<void> {
	const matrixConfig = loadMatrixConfig();
	const codexConfig = loadCodexAppServerConfig();

	const client = new MatrixClient(matrixConfig.homeserverUrl, matrixConfig.accessToken);
	const codexAppServer = createCodexAppServer(codexConfig.command, codexConfig.args);

	if (codexAppServer) {
		registerCodexAppServerHandlers(codexAppServer, client);
		codexAppServer.start();
	}

	registerMatrixClientHandlers(client, matrixConfig, codexAppServer);
	registerShutdownHandlers(codexAppServer);

	await client.start();

	LogService.info("matrix-runner", "Bot runner started");
}

main().catch((error) => {
	console.error("Fatal startup error", error);
	process.exit(1);
});
