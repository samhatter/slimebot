import {
  asRecord,
  optionalString,
  readStringArray,
  type JsonRecord
} from "../config/parsing.js";

export type CodexAppServerConfig = {
  command: string;
  args: string[];
};

export function parseCodexAppServerConfig(root: JsonRecord): CodexAppServerConfig {
  const codexRecord = asRecord(root["codex"]) ?? {};

  return {
    command: optionalString(codexRecord, "command") ?? "./node_modules/.bin/codex",
    args: readStringArray(codexRecord, "args", ["app-server", "--listen", "stdio://"])
  };
}
