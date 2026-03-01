import type { ChannelConfig } from "./config.js";
import type { Channel } from "./channel.js";
import { MatrixChannel } from "./matrix/matrixChannel.js";

export function createChannel(config: ChannelConfig): Channel {
  return new MatrixChannel(config.matrix);
}
