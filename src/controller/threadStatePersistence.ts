/**
 * @fileoverview Per-thread controller state persistence helpers.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { asRecord } from "./commands.js";

export type PersistedThreadState = {
  inFlightTurnId?: string;
  pendingCompaction?: boolean;
  pendingInterruptTurnId?: string;
  reasoningEffort?: "low" | "medium" | "high";
  modelOverride?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    lastInputTokens?: number;
    lastOutputTokens?: number;
    lastTotalTokens?: number;
  };
};

export type PersistedThreadStatePayload = {
  threadStateByThreadId: Map<string, PersistedThreadState>;
  toolActivityMessagesEnabled?: boolean;
};

/** Loads persisted thread state from disk, returning an empty map on failure. */
export function loadPersistedThreadState(
  threadStatePersistencePath: string,
  logInfo: (message: string) => void,
  logWarn: (message: string) => void
): PersistedThreadStatePayload {
  try {
    const rawState = readFileSync(threadStatePersistencePath, "utf8");
    if (!rawState.trim()) {
      return { threadStateByThreadId: new Map<string, PersistedThreadState>() };
    }

    const parsedState = JSON.parse(rawState) as unknown;
    const stateRecord = asRecord(parsedState);
    const threads = asRecord(stateRecord?.["threads"]);
    const threadState = new Map<string, PersistedThreadState>();
    const toolActivityMessagesEnabled = typeof stateRecord?.["toolActivityMessagesEnabled"] === "boolean"
      ? stateRecord["toolActivityMessagesEnabled"]
      : undefined;

    if (!threads) {
      return {
        threadStateByThreadId: threadState,
        toolActivityMessagesEnabled
      };
    }

    for (const [threadId, rawThreadState] of Object.entries(threads)) {
      if (!threadId) {
        continue;
      }

      const threadStateRecord = asRecord(rawThreadState);
      if (!threadStateRecord) {
        continue;
      }

      const tokenUsageRecord = asRecord(threadStateRecord["tokenUsage"]);
      const tokenUsage = tokenUsageRecord
        ? {
            inputTokens: typeof tokenUsageRecord["inputTokens"] === "number" ? Math.trunc(tokenUsageRecord["inputTokens"]) : undefined,
            outputTokens: typeof tokenUsageRecord["outputTokens"] === "number" ? Math.trunc(tokenUsageRecord["outputTokens"]) : undefined,
            totalTokens: typeof tokenUsageRecord["totalTokens"] === "number" ? Math.trunc(tokenUsageRecord["totalTokens"]) : undefined,
            lastInputTokens: typeof tokenUsageRecord["lastInputTokens"] === "number" ? Math.trunc(tokenUsageRecord["lastInputTokens"]) : undefined,
            lastOutputTokens: typeof tokenUsageRecord["lastOutputTokens"] === "number" ? Math.trunc(tokenUsageRecord["lastOutputTokens"]) : undefined,
            lastTotalTokens: typeof tokenUsageRecord["lastTotalTokens"] === "number" ? Math.trunc(tokenUsageRecord["lastTotalTokens"]) : undefined
          }
        : undefined;

      const reasoningEffortRaw = threadStateRecord["reasoningEffort"];
      const reasoningEffort = reasoningEffortRaw === "low" || reasoningEffortRaw === "medium" || reasoningEffortRaw === "high"
        ? reasoningEffortRaw
        : undefined;

      const parsedThreadState: PersistedThreadState = {
        inFlightTurnId: typeof threadStateRecord["inFlightTurnId"] === "string" ? threadStateRecord["inFlightTurnId"] : undefined,
        pendingCompaction: threadStateRecord["pendingCompaction"] === true,
        pendingInterruptTurnId: typeof threadStateRecord["pendingInterruptTurnId"] === "string" ? threadStateRecord["pendingInterruptTurnId"] : undefined,
        reasoningEffort,
        modelOverride: typeof threadStateRecord["modelOverride"] === "string" ? threadStateRecord["modelOverride"] : undefined,
        tokenUsage
      };

      threadState.set(threadId, parsedThreadState);
    }

    logInfo(`Loaded ${String(threadState.size)} persisted thread state record(s)`);
    return {
      threadStateByThreadId: threadState,
      toolActivityMessagesEnabled
    };
  } catch (error) {
    const isMissingFileError =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";

    if (isMissingFileError) {
      return { threadStateByThreadId: new Map<string, PersistedThreadState>() };
    }

    logWarn(`Failed to load thread state from ${threadStatePersistencePath}: ${String(error)}`);
    return { threadStateByThreadId: new Map<string, PersistedThreadState>() };
  }
}

/** Persists per-thread state to disk as a JSON state file. */
export function persistThreadState(
  threadStatePersistencePath: string,
  payload: {
    threadStateByThreadId: ReadonlyMap<string, PersistedThreadState>;
    toolActivityMessagesEnabled: boolean;
  },
  logWarn: (message: string) => void
): void {
  try {
    mkdirSync(dirname(threadStatePersistencePath), { recursive: true });
    const serializableState = {
      toolActivityMessagesEnabled: payload.toolActivityMessagesEnabled,
      threads: Object.fromEntries(payload.threadStateByThreadId.entries())
    };
    writeFileSync(threadStatePersistencePath, `${JSON.stringify(serializableState, null, 2)}\n`, "utf8");
  } catch (error) {
    logWarn(`Failed to persist thread state to ${threadStatePersistencePath}: ${String(error)}`);
  }
}
