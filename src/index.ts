import { loadCodexAppServerConfig } from "./codex/codexAppServerConfig.js";
import { BotController } from "./controller/botController.js";
import { loadMatrixConfig } from "./matrix/matrixConfig.js";

async function main(): Promise<void> {
	const matrixConfig = loadMatrixConfig();
	const codexConfig = loadCodexAppServerConfig();
	const controller = new BotController(matrixConfig, codexConfig);
	await controller.start();
}

main().catch((error) => {
	console.error("Fatal startup error", error);
	process.exit(1);
});
