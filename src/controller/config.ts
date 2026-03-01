import { asRecord, optionalString, type JsonRecord } from "../config/parsing.js";

export type ControllerConfig = {
  commandPrefix: string;
  routingPersistencePath: string;
};

export function parseControllerConfig(root: JsonRecord): ControllerConfig {
  const controllerRecord = asRecord(root["controller"]);

  return {
    commandPrefix: optionalString(controllerRecord ?? {}, "commandPrefix") ?? "!",
    routingPersistencePath: optionalString(controllerRecord ?? {}, "routingPersistencePath") ?? "/app/slimebot-routing.json"
  };
}
