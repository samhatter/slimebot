/**
 * @fileoverview Slimebot application entrypoint.
 */

import { loadAppConfig } from "./config/config.js";
import { BotController } from "./controller/controller.js";

/** Bootstraps configuration, creates controller, and starts the bot. */
async function main(): Promise<void> {
	const appConfig = loadAppConfig();
	const controller = new BotController(appConfig);
	await controller.start();
}

main().catch((error) => {
	console.error("Fatal startup error", error);
	process.exit(1);
});
