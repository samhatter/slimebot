/**
 * @fileoverview Channel configuration models and parsing helpers.
 */

import { asRecord, requiredString, type JsonRecord } from "../config/parsing.js";
import { parseMatrixConfig, type MatrixConfig } from "./matrix/config.js";

/** Parsed channel configuration shape. */
export type ChannelConfig = {
  type: "matrix";
  matrix: MatrixConfig;
};

/** Parses channel configuration from the root app config object. */
export function parseChannelConfig(root: JsonRecord): ChannelConfig {
  const channelRecord = asRecord(root["channel"]);
  if (!channelRecord) {
    throw new Error("Missing required object 'channel'");
  }

  const channelType = requiredString(channelRecord, "type");
  if (channelType !== "matrix") {
    throw new Error(`Unsupported channel.type '${channelType}'. Currently only 'matrix' is supported.`);
  }

  return {
    type: "matrix",
    matrix: parseMatrixConfig(channelRecord["matrix"])
  };
}
