/**
 * @fileoverview SQLite-backed state persistence for room-thread routes and per-thread controller state.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeScheduleSpec, type ScheduleSpec } from "./scheduleSpec.js";

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

type ScheduleJobStatus = "active" | "cancelled" | "completed";

export type ScheduleJobRecord = {
  id: number;
  roomId: string;
  threadId: string;
  message: string;
  spec: ScheduleSpec;
  nextRunAtMs?: number;
  createdAtMs: number;
  lastRunAtMs?: number;
  status: ScheduleJobStatus;
  lastError?: string;
};

export type ActiveScheduleJobRecord = ScheduleJobRecord & {
  status: "active";
  nextRunAtMs: number;
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

  /** Creates a new schedule job from a unified schedule spec. */
  public createScheduleJob(input: {
    roomId: string;
    threadId: string;
    message: string;
    spec: ScheduleSpec;
    nextRunAtMs: number;
  }): ActiveScheduleJobRecord {
    const createdAtMs = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO schedule_jobs (
          room_id,
          thread_id,
          message,
          spec_json,
          next_run_at_ms,
          created_at_ms,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, 'active')`
      )
      .run(
        input.roomId,
        input.threadId,
        input.message,
        JSON.stringify(input.spec),
        input.nextRunAtMs,
        createdAtMs
      );

    return {
      id: Number(result.lastInsertRowid),
      roomId: input.roomId,
      threadId: input.threadId,
      message: input.message,
      spec: input.spec,
      nextRunAtMs: input.nextRunAtMs,
      createdAtMs,
      status: "active"
    };
  }

  /** Lists active schedule jobs for a room. */
  public listActiveScheduleJobsByRoom(roomId: string): ActiveScheduleJobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
          id,
          room_id,
          thread_id,
          message,
          spec_json,
          next_run_at_ms,
          created_at_ms,
          last_run_at_ms,
          status,
          last_error
         FROM schedule_jobs
         WHERE room_id = ? AND status = 'active'
         ORDER BY next_run_at_ms ASC`
      )
      .all(roomId) as Array<{
        id?: unknown;
        room_id?: unknown;
        thread_id?: unknown;
        message?: unknown;
        spec_json?: unknown;
        next_run_at_ms?: unknown;
        created_at_ms?: unknown;
        last_run_at_ms?: unknown;
        status?: unknown;
        last_error?: unknown;
      }>;

    return rows
      .map((row) => toActiveScheduleJobRecord(row))
      .filter((row): row is ActiveScheduleJobRecord => row !== undefined);
  }

  /** Lists all active schedule jobs. */
  public listAllActiveScheduleJobs(): ActiveScheduleJobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
          id,
          room_id,
          thread_id,
          message,
          spec_json,
          next_run_at_ms,
          created_at_ms,
          last_run_at_ms,
          status,
          last_error
         FROM schedule_jobs
         WHERE status = 'active'
         ORDER BY next_run_at_ms ASC`
      )
      .all() as Array<{
        id?: unknown;
        room_id?: unknown;
        thread_id?: unknown;
        message?: unknown;
        spec_json?: unknown;
        next_run_at_ms?: unknown;
        created_at_ms?: unknown;
        last_run_at_ms?: unknown;
        status?: unknown;
        last_error?: unknown;
      }>;

    return rows
      .map((row) => toActiveScheduleJobRecord(row))
      .filter((row): row is ActiveScheduleJobRecord => row !== undefined);
  }

  /** Cancels an active schedule job in the room. */
  public cancelScheduleJob(roomId: string, id: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE schedule_jobs
         SET status = 'cancelled', next_run_at_ms = NULL
         WHERE id = ? AND room_id = ? AND status = 'active'`
      )
      .run(id, roomId);
    return result.changes > 0;
  }

  /**
   * Advances a schedule job after one run attempt.
   *
   * If `nextRunAtMs` is provided, job remains active and the updated record is returned.
   * If not, job is marked completed and undefined is returned.
   */
  public advanceScheduleJobAfterRun(input: {
    id: number;
    lastRunAtMs: number;
    nextRunAtMs?: number;
    lastError?: string;
  }): ActiveScheduleJobRecord | undefined {
    if (Number.isFinite(input.nextRunAtMs)) {
      this.db
        .prepare(
          `UPDATE schedule_jobs
           SET
             status = 'active',
             next_run_at_ms = ?,
             last_run_at_ms = ?,
             last_error = ?
           WHERE id = ?`
        )
        .run(
          Math.trunc(input.nextRunAtMs as number),
          Math.trunc(input.lastRunAtMs),
          input.lastError ?? null,
          input.id
        );
      return this.readActiveScheduleJobById(input.id);
    }

    this.db
      .prepare(
        `UPDATE schedule_jobs
         SET
           status = 'completed',
           next_run_at_ms = NULL,
           last_run_at_ms = ?,
           last_error = ?
         WHERE id = ?`
    )
      .run(Math.trunc(input.lastRunAtMs), input.lastError ?? null, input.id);
    return undefined;
  }

  /** Reads a single active schedule job by id. */
  private readActiveScheduleJobById(id: number): ActiveScheduleJobRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT
          id,
          room_id,
          thread_id,
          message,
          spec_json,
          next_run_at_ms,
          created_at_ms,
          last_run_at_ms,
          status,
          last_error
         FROM schedule_jobs
         WHERE id = ? AND status = 'active'
         LIMIT 1`
      )
      .get(id) as {
        id?: unknown;
        room_id?: unknown;
        thread_id?: unknown;
        message?: unknown;
        spec_json?: unknown;
        next_run_at_ms?: unknown;
        created_at_ms?: unknown;
        last_run_at_ms?: unknown;
        status?: unknown;
        last_error?: unknown;
      } | undefined;
    if (!row) {
      return undefined;
    }

    return toActiveScheduleJobRecord(row);
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
      CREATE TABLE IF NOT EXISTS schedule_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        next_run_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        last_run_at_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_jobs_status_next_run_at
        ON schedule_jobs (status, next_run_at_ms);
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

function toActiveScheduleJobRecord(row: {
  id?: unknown;
  room_id?: unknown;
  thread_id?: unknown;
  message?: unknown;
  spec_json?: unknown;
  next_run_at_ms?: unknown;
  created_at_ms?: unknown;
  last_run_at_ms?: unknown;
  status?: unknown;
  last_error?: unknown;
}): ActiveScheduleJobRecord | undefined {
  if (
    typeof row.id !== "number"
    || typeof row.room_id !== "string"
    || typeof row.thread_id !== "string"
    || typeof row.message !== "string"
    || typeof row.spec_json !== "string"
    || typeof row.next_run_at_ms !== "number"
    || typeof row.created_at_ms !== "number"
    || row.status !== "active"
  ) {
    return undefined;
  }

  let spec: ScheduleSpec;
  try {
    const parsedSpec = JSON.parse(row.spec_json) as {
      version: string;
      timezone: string;
      dtstart: string;
      rrule: string;
    };
    spec = normalizeScheduleSpec(parsedSpec);
  } catch {
    return undefined;
  }

  return {
    id: Math.trunc(row.id),
    roomId: row.room_id,
    threadId: row.thread_id,
    message: row.message,
    spec,
    nextRunAtMs: Math.trunc(row.next_run_at_ms),
    createdAtMs: Math.trunc(row.created_at_ms),
    lastRunAtMs: typeof row.last_run_at_ms === "number" ? Math.trunc(row.last_run_at_ms) : undefined,
    status: "active",
    lastError: typeof row.last_error === "string" ? row.last_error : undefined
  };
}
