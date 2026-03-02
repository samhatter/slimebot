/**
 * @fileoverview Controller response helpers.
 */

/** Safely narrows unknown values into record-like objects. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

/** Extracts an auth URL string from account/login/start responses. */
export function getAuthUrlFromLoginResult(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) {
    return undefined;
  }

  const authUrl = record["authUrl"];
  return typeof authUrl === "string" ? authUrl : undefined;
}