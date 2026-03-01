import { EventEmitter } from "node:events";

export class ChannelMessage {
  public readonly roomId: string;
  public readonly sender: string;
  public readonly body: string;
  public readonly originServerTs?: number;

  public constructor(params: {
    roomId: string;
    sender: string;
    body: string;
    originServerTs?: number;
  }) {
    this.roomId = params.roomId;
    this.sender = params.sender;
    this.body = params.body;
    this.originServerTs = params.originServerTs;
  }
}

export class ChannelOutboundMessage {
  public readonly body: string;

  public constructor(params: {
    body: string;
  }) {
    this.body = params.body;
  }
}

export abstract class Channel extends EventEmitter {
  public abstract start(): Promise<void>;

  public abstract sendTextMessage(roomId: string, message: ChannelOutboundMessage): Promise<void>;

  public onMessage(listener: (event: ChannelMessage) => void | Promise<void>): this {
    super.on("message", listener as (...args: unknown[]) => void);
    return this;
  }

  protected emitMessage(event: ChannelMessage): boolean {
    return this.emit("message", event);
  }
}
