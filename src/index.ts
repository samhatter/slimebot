import { loadAppConfig } from "./appConfig.js";
import { BotController } from "./botController.js";

async function main(): Promise<void> {
	const appConfig = loadAppConfig();
	const controller = new BotController(appConfig);
	await controller.start();
}

main().catch((error) => {
	console.error("Fatal startup error", error);
	process.exit(1);
});
