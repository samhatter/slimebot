import { startMatrixBotRunner } from "./matrixRunner.js";

async function main(): Promise<void> {
	await startMatrixBotRunner();
}

main().catch((error) => {
	console.error("Fatal startup error", error);
	process.exit(1);
});
