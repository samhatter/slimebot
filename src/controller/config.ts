/**
 * @fileoverview Controller configuration models and parsing helpers.
 */

import { asRecord, optionalString, type JsonRecord } from "../config/parsing.js";

/** Parsed controller configuration shape. */
export type ControllerConfig = {
  commandPrefix: string;
  routingPersistencePath: string;
};

/** Parses controller configuration from root app config. */
export function parseControllerConfig(root: JsonRecord): ControllerConfig {
  const controllerRecord = asRecord(root["controller"]);

  return {
    commandPrefix: optionalString(controllerRecord ?? {}, "commandPrefix") ?? "!",
    routingPersistencePath: optionalString(controllerRecord ?? {}, "routingPersistencePath") ?? "/app/slimebot-routing.json"
  };
}
