/**
 * @fileoverview Shared parsing helpers for config value extraction and validation.
 */

export type JsonRecord = Record<string, unknown>;

/** Safely narrows an unknown value to a JSON object record. */
export function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as JsonRecord;
}

/** Reads an optional string value from a record and trims whitespace. */
export function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected string for '${key}'`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Reads a required string value from a record. */
export function requiredString(record: JsonRecord, key: string): string {
  const value = optionalString(record, key);
  if (!value) {
    throw new Error(`Missing required string '${key}'`);
  }

  return value;
}

/** Reads a string array from a record with validation and defaults. */
export function readStringArray(record: JsonRecord, key: string, defaultValue: string[]): string[] {
  const value = record[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Expected array for '${key}'`);
  }

  const strings = value
    .map((item) => {
      if (typeof item !== "string") {
        throw new Error(`Expected all '${key}' entries to be strings`);
      }

      return item.trim();
    })
    .filter((item) => item.length > 0);

  return strings.length > 0 ? strings : defaultValue;
}
