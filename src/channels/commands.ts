/**
 * @fileoverview Transport-agnostic command catalog for controller-dispatchable commands.
 */

/** Canonical command names supported by the controller. */
export const controllerCommandNames = [
  "help",
  "new",
  "resume",
  "thread",
  "threads",
  "rollback",
  "compact",
  "archive",
  "unarchive",
  "interrupt",
  "approve",
  "skip",
  "login",
  "callback",
  "models",
  "model",
  "account",
  "reasoning",
  "verbosity"
] as const;

/** Canonical controller command name. */
export type ControllerCommandName = (typeof controllerCommandNames)[number];

/** Parsed controller command with canonical name and args. */
export type ControllerCommand = {
  name: ControllerCommandName;
  args: string[];
};

const supportedCommandSet = new Set<string>(controllerCommandNames);

/** Type guard for canonical command names. */
export function isControllerCommandName(value: string): value is ControllerCommandName {
  return supportedCommandSet.has(value);
}