/**
 * @fileoverview Controller configuration models and parsing helpers.
 */

import { asRecord, optionalString, type JsonRecord } from "../config/parsing.js";

/** Parsed controller configuration shape. */
export type ControllerConfig = {
  commandPrefix: string;
  stateDatabasePath: string;
};

/** Parses controller configuration from root app config. */
export function parseControllerConfig(root: JsonRecord): ControllerConfig {
  const controllerRecord = asRecord(root["controller"]);

  return {
    commandPrefix: optionalString(controllerRecord ?? {}, "commandPrefix") ?? "!",
    stateDatabasePath: optionalString(controllerRecord ?? {}, "stateDatabasePath") ?? "/app/state/slimebot-state.sqlite3"
  };
}
