/**
 * @fileoverview Matrix message command parsing and alias normalization.
 */

import {
  isControllerCommandName,
  type ControllerCommand
} from "../commands.js";

const matrixCommandAliases: Record<string, string> = {
  i: "interrupt",
  a: "approve",
  s: "skip",
  r: "reasoning",
  m: "model",
  v: "verbosity",
  n: "new",
  t: "thread",
  sch: "schedule"
};

/** Parses a raw Matrix text message into a controller command, if any. */
export function parseMatrixCommand(body: string): ControllerCommand | undefined {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!trimmed.startsWith("!")) {
    return undefined;
  }

  const tokens = trimmed.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }

  const firstToken = tokens[0].slice(1);
  if (!firstToken) {
    return undefined;
  }

  const normalizedToken = firstToken.toLowerCase();
  const commandName = matrixCommandAliases[normalizedToken] ?? normalizedToken;
  if (!isControllerCommandName(commandName)) {
    return undefined;
  }

  return {
    name: commandName,
    args: tokens.slice(1)
  };
}
