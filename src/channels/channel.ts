/**
 * @fileoverview Channel abstraction for inbound events and high-level outbound replies.
 */

import { EventEmitter } from "node:events";
import type { ControllerCommand } from "./commands.js";

/** Shape for thread status messages rendered by channel implementations. */
export type ChannelThreadStatusView = {
  threadId: string;
  name: string;
  preview: string;
  updatedAt: string;
  modelProvider: string;
  selectedModel: string;
  statusType: string;
  agentNickname: string;
  agentRole: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  lastTotalTokens?: number;
  defaultEffort: string;
};

/** Shape for approval request messages rendered by channel implementations. */
export type ChannelApprovalRequest = {
  approvalType: string;
  threadId: string;
  turnId: string;
  itemId: string;
  commandPreview?: string;
  reason?: string;
};

/** Shape for tool-start notifications rendered by channel implementations. */
export type ChannelToolActivityStarted = {
  itemType: string;
  snapshot?: unknown;
};

/** Shape for tool-completion notifications rendered by channel implementations. */
export type ChannelToolActivityCompleted = {
  completionLabel: string;
  itemType: string;
  elapsedSeconds: string;
  itemError?: string;
  snapshot?: unknown;
};

/** Normalized inbound room message event emitted by channel implementations. */
export class ChannelMessage {
  public readonly roomId: string;
  public readonly sender: string;
  public readonly body: string;
  public readonly originServerTs?: number;
  public readonly command?: ControllerCommand;

  public constructor(params: {
    roomId: string;
    sender: string;
    body: string;
    originServerTs?: number;
    command?: ControllerCommand;
  }) {
    this.roomId = params.roomId;
    this.sender = params.sender;
    this.body = params.body;
    this.originServerTs = params.originServerTs;
    this.command = params.command;
  }
}

/** Generic outbound message payload used by channel transport internals. */
export class ChannelOutboundMessage {
  public readonly body: string;
  public readonly formattedBody?: string;
  public readonly format?: string;

  public constructor(params: {
    body: string;
    formattedBody?: string;
    format?: string;
  }) {
    this.body = params.body;
    this.formattedBody = params.formattedBody;
    this.format = params.format;
  }
}

/**
 * Base channel contract.
 *
 * Implementations must provide high-level messaging helpers so the controller
 * stays transport-agnostic.
 */
export abstract class Channel extends EventEmitter {
  /** Starts the channel connection and event listeners. */
  public abstract start(): Promise<void>;

  /** Sends a plain system message intended for status/errors. */
  public abstract sendSystemMessage(roomId: string, body: string): Promise<void>;

  /** Sends a direct Codex assistant reply. */
  public abstract sendCodexReply(roomId: string, body: string): Promise<void>;

  /** Sends the controller help command output. */
  public abstract sendHelp(roomId: string, lines: string[]): Promise<void>;

  /** Sends a rendered thread list response. */
  public abstract sendThreadList(roomId: string, result: unknown, archived: boolean): Promise<void>;

  /** Sends a rendered thread status response. */
  public abstract sendThreadStatus(roomId: string, input: ChannelThreadStatusView): Promise<void>;

  /** Sends a rendered model list response. */
  public abstract sendModelList(roomId: string, result: unknown): Promise<void>;

  /** Sends a rendered JSON response with a title. */
  public abstract sendJsonResponse(roomId: string, title: string, value: unknown): Promise<void>;

  /** Sends an approval request prompt. */
  public abstract sendApprovalRequest(roomId: string, request: ChannelApprovalRequest): Promise<void>;

  /** Sends a tool-start activity notification. */
  public abstract sendToolActivityStarted(roomId: string, activity: ChannelToolActivityStarted): Promise<void>;

  /** Sends a tool-completion activity notification. */
  public abstract sendToolActivityCompleted(roomId: string, activity: ChannelToolActivityCompleted): Promise<void>;

  /** Sends a compaction completion notification. */
  public abstract sendCompactionCompleted(roomId: string, threadId: string, turnId?: string): Promise<void>;

  /** Indicates a turn has started processing for the room. */
  public abstract indicateTurnStarted(roomId: string): Promise<void>;

  /** Indicates a turn has finished processing for the room. */
  public abstract indicateTurnEnded(roomId: string): Promise<void>;

  /** Registers a message handler for inbound room messages. */
  public onMessage(listener: (event: ChannelMessage) => void | Promise<void>): this {
    super.on("message", listener as (...args: unknown[]) => void);
    return this;
  }

  /** Emits a normalized inbound message event to subscribers. */
  protected emitMessage(event: ChannelMessage): boolean {
    return this.emit("message", event);
  }
}
