import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { asRecord } from "./commands.js";

export function loadPersistedRoomThreadRoutes(
  routingPersistencePath: string,
  logInfo: (message: string) => void,
  logWarn: (message: string) => void
): Map<string, string> {
  try {
    const rawState = readFileSync(routingPersistencePath, "utf8");
    if (!rawState.trim()) {
      return new Map<string, string>();
    }

    const parsedState = JSON.parse(rawState) as unknown;
    const stateRecord = asRecord(parsedState);
    const routes = asRecord(stateRecord?.["roomThreadRoutes"]);
    if (!routes) {
      return new Map<string, string>();
    }

    const roomThreadRoutes = new Map<string, string>();
    for (const [roomId, threadId] of Object.entries(routes)) {
      if (typeof threadId === "string" && roomId && threadId) {
        roomThreadRoutes.set(roomId, threadId);
      }
    }

    logInfo(`Loaded ${String(roomThreadRoutes.size)} persisted room-thread route(s)`);
    return roomThreadRoutes;
  } catch (error) {
    const isMissingFileError =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";

    if (isMissingFileError) {
      return new Map<string, string>();
    }

    logWarn(`Failed to load room-thread routes from ${routingPersistencePath}: ${String(error)}`);
    return new Map<string, string>();
  }
}

export function persistRoomThreadRoutes(
  routingPersistencePath: string,
  roomThreadRoutes: ReadonlyMap<string, string>,
  logWarn: (message: string) => void
): void {
  try {
    mkdirSync(dirname(routingPersistencePath), { recursive: true });
    const serializableState = {
      roomThreadRoutes: Object.fromEntries(roomThreadRoutes.entries())
    };
    writeFileSync(routingPersistencePath, `${JSON.stringify(serializableState, null, 2)}\n`, "utf8");
  } catch (error) {
    logWarn(`Failed to persist room-thread routes to ${routingPersistencePath}: ${String(error)}`);
  }
}
