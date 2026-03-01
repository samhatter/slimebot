import { asRecord, optionalString, type JsonRecord } from "../config/parsing.js";

export type ControllerConfig = {
  commandPrefix: string;
};

export function parseControllerConfig(root: JsonRecord): ControllerConfig {
  const controllerRecord = asRecord(root["controller"]);

  return {
    commandPrefix: optionalString(controllerRecord ?? {}, "commandPrefix") ?? "!"
  };
}
