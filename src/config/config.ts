import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { parseChannelConfig, type ChannelConfig } from "../channels/config.js";
import { parseCodexAppServerConfig, type CodexAppServerConfig } from "../codexProcess/config.js";
import { parseControllerConfig, type ControllerConfig } from "../controller/config.js";
import { asRecord } from "./parsing.js";

export type AppConfig = {
  channel: ChannelConfig;
  controller: ControllerConfig;
  codex: CodexAppServerConfig;
};

export function loadAppConfig(configPath?: string): AppConfig {
  const resolvedPath = resolve(configPath ?? process.env.SLIMEBOT_CONFIG_PATH ?? "slimebot.yaml");
  const yamlText = readFileSync(resolvedPath, "utf8");
  const parsed = loadYaml(yamlText) as unknown;
  const root = asRecord(parsed);

  if (!root) {
    throw new Error(`Config file must contain a YAML object at root: ${resolvedPath}`);
  }

  return {
    channel: parseChannelConfig(root),
    controller: parseControllerConfig(root),
    codex: parseCodexAppServerConfig(root)
  };
}