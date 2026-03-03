/**
 * @fileoverview Codex app-server process configuration models and parsing helpers.
 */

import {
  asRecord,
  optionalString,
  readStringArray,
  type JsonRecord
} from "../config/parsing.js";
import { type CodexAppServerProcessOptions } from "./codexAppServerProcess.js";

export type CodexAppServerConfig = {
  command: string;
  args: string[];
  options: CodexAppServerProcessOptions;
};

/** Parses Codex process config from root app config with defaults. */
export function parseCodexAppServerConfig(root: JsonRecord): CodexAppServerConfig {
  const codexRecord = asRecord(root["codex"]) ?? {};

  return {
    command: optionalString(codexRecord, "command") ?? "/app/node_modules/.bin/codex",
    args: readStringArray(codexRecord, "args", ["app-server", "--listen", "stdio://"]),
    options: {
      cwd: optionalString(codexRecord, "cwd") ?? "/var/lib/slimebot/workspace"
    }
  };
}
