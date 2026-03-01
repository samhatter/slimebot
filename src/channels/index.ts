/**
 * @fileoverview Channel factory for selecting concrete channel implementations.
 */

import type { ChannelConfig } from "./config.js";
import type { Channel } from "./channel.js";
import { MatrixChannel } from "./matrix/matrixChannel.js";

/** Creates the configured channel implementation. */
export function createChannel(config: ChannelConfig): Channel {
  return new MatrixChannel(config.matrix);
}
