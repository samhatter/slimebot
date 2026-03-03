/**
 * @fileoverview SQLite-backed state persistence for room-thread routes and per-thread controller state.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

type ReasoningEffort = "low" | "medium" | "high";

type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  lastTotalTokens?: number;
};

export type PersistedThreadState = {
  inFlightTurnId?: string;
  pendingCompaction?: boolean;
  pendingInterruptTurnId?: string;
  reasoningEffort?: ReasoningEffort;
  modelOverride?: string;
  tokenUsage?: TokenUsage;
};

export type PersistedStatePayload = {
  roomThreadRoutes: Map<string, string>;
  threadStateByThreadId: Map<string, PersistedThreadState>;
  toolActivityMessagesEnabled?: boolean;
};

/** Encapsulates all SQLite state persistence operations. */
export class StateDatabase {
  private readonly db: DatabaseSync;

  public constructor(
    private readonly stateDatabasePath: string,
    private readonly logInfo: (message: string) => void,
    private readonly logWarn: (message: string) => void
  ) {
    mkdirSync(dirname(stateDatabasePath), { recursive: true });
    this.db = new DatabaseSync(stateDatabasePath);
    this.initializeSchema();
  }

  /** Loads all persisted state from SQLite. */
  public loadState(): PersistedStatePayload {
    const roomThreadRoutes = new Map<string, string>();
    const threadStateByThreadId = new Map<string, PersistedThreadState>();

    try {
      const routeRows = this.db.prepare("SELECT room_id, thread_id FROM room_thread_routes").all() as Array<{
        room_id?: unknown;
        thread_id?: unknown;
      }>;

      for (const row of routeRows) {
        if (typeof row.room_id === "string" && typeof row.thread_id === "string" && row.room_id && row.thread_id) {
          roomThreadRoutes.set(row.room_id, row.thread_id);
        }
      }

      const threadRows = this.db.prepare(
        `SELECT
          thread_id,
          in_flight_turn_id,
          pending_compaction,
          pending_interrupt_turn_id,
          reasoning_effort,
          model_override,
          token_usage_json
         FROM thread_state`
      ).all() as Array<{
        thread_id?: unknown;
        in_flight_turn_id?: unknown;
        pending_compaction?: unknown;
        pending_interrupt_turn_id?: unknown;
        reasoning_effort?: unknown;
        model_override?: unknown;
        token_usage_json?: unknown;
      }>;

      for (const row of threadRows) {
        if (typeof row.thread_id !== "string" || !row.thread_id) {
          continue;
        }

        const reasoningEffort =
          row.reasoning_effort === "low" || row.reasoning_effort === "medium" || row.reasoning_effort === "high"
            ? row.reasoning_effort
            : undefined;

        const threadState: PersistedThreadState = {
          inFlightTurnId: typeof row.in_flight_turn_id === "string" ? row.in_flight_turn_id : undefined,
          pendingCompaction: row.pending_compaction === 1,
          pendingInterruptTurnId:
            typeof row.pending_interrupt_turn_id === "string" ? row.pending_interrupt_turn_id : undefined,
          reasoningEffort,
          modelOverride: typeof row.model_override === "string" ? row.model_override : undefined,
          tokenUsage: parseTokenUsageJson(row.token_usage_json)
        };

        threadStateByThreadId.set(row.thread_id, threadState);
      }

      const metadataRow = this.db
        .prepare("SELECT value FROM metadata WHERE key = 'toolActivityMessagesEnabled' LIMIT 1")
        .get() as { value?: unknown } | undefined;

      const toolActivityMessagesEnabled =
        metadataRow?.value === "true" ? true : metadataRow?.value === "false" ? false : undefined;

      this.logInfo(
        `Loaded ${String(roomThreadRoutes.size)} room route(s) and ${String(threadStateByThreadId.size)} thread state record(s) from ${this.stateDatabasePath}`
      );

      return {
        roomThreadRoutes,
        threadStateByThreadId,
        toolActivityMessagesEnabled
      };
    } catch (error) {
      this.logWarn(`Failed to load state from ${this.stateDatabasePath}: ${String(error)}`);
      return {
        roomThreadRoutes,
        threadStateByThreadId
      };
    }
  }

  /** Persists all room-thread routes atomically. */
  public persistRoomThreadRoutes(roomThreadRoutes: ReadonlyMap<string, string>): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec("DELETE FROM room_thread_routes");

      const insert = this.db.prepare("INSERT INTO room_thread_routes (room_id, thread_id) VALUES (?, ?)");
      for (const [roomId, threadId] of roomThreadRoutes.entries()) {
        insert.run(roomId, threadId);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      safeRollback(this.db);
      this.logWarn(`Failed to persist room-thread routes to ${this.stateDatabasePath}: ${String(error)}`);
    }
  }

  /** Persists all thread state + global controller metadata atomically. */
  public persistThreadState(payload: {
    threadStateByThreadId: ReadonlyMap<string, PersistedThreadState>;
    toolActivityMessagesEnabled: boolean;
  }): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec("DELETE FROM thread_state");

      const insertThread = this.db.prepare(
        `INSERT INTO thread_state (
          thread_id,
          in_flight_turn_id,
          pending_compaction,
          pending_interrupt_turn_id,
          reasoning_effort,
          model_override,
          token_usage_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (const [threadId, state] of payload.threadStateByThreadId.entries()) {
        insertThread.run(
          threadId,
          state.inFlightTurnId ?? null,
          state.pendingCompaction === true ? 1 : 0,
          state.pendingInterruptTurnId ?? null,
          state.reasoningEffort ?? null,
          state.modelOverride ?? null,
          stringifyTokenUsage(state.tokenUsage)
        );
      }

      this.db
        .prepare(
          "INSERT INTO metadata (key, value) VALUES ('toolActivityMessagesEnabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(payload.toolActivityMessagesEnabled ? "true" : "false");

      this.db.exec("COMMIT");
    } catch (error) {
      safeRollback(this.db);
      this.logWarn(`Failed to persist thread state to ${this.stateDatabasePath}: ${String(error)}`);
    }
  }

  /** Creates required schema objects if they don't already exist. */
  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS room_thread_routes (
        room_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_state (
        thread_id TEXT PRIMARY KEY,
        in_flight_turn_id TEXT,
        pending_compaction INTEGER NOT NULL DEFAULT 0,
        pending_interrupt_turn_id TEXT,
        reasoning_effort TEXT,
        model_override TEXT,
        token_usage_json TEXT
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }
}

function safeRollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // no-op; rollback can fail when no transaction is active
  }
}

function stringifyTokenUsage(tokenUsage: TokenUsage | undefined): string | null {
  if (!tokenUsage) {
    return null;
  }

  if (!Object.values(tokenUsage).some((value) => value !== undefined)) {
    return null;
  }

  return JSON.stringify(tokenUsage);
}

function parseTokenUsageJson(value: unknown): TokenUsage | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }

    const tokenUsage = parsed as Record<string, unknown>;
    return {
      inputTokens: readInteger(tokenUsage.inputTokens),
      outputTokens: readInteger(tokenUsage.outputTokens),
      totalTokens: readInteger(tokenUsage.totalTokens),
      lastInputTokens: readInteger(tokenUsage.lastInputTokens),
      lastOutputTokens: readInteger(tokenUsage.lastOutputTokens),
      lastTotalTokens: readInteger(tokenUsage.lastTotalTokens)
    };
  } catch {
    return undefined;
  }
}

function readInteger(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }

  return Math.trunc(value);
}
