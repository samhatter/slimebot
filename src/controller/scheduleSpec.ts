/**
 * @fileoverview Unified schedule spec parsing and recurrence utilities.
 */

import { RRule } from "rrule";

export type ScheduleSpec = {
  version: "v1";
  timezone: string;
  dtstart: string;
  rrule: string;
};

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`Invalid timezone '${timeZone}'.`);
  }
}

function createRuleFromSpec(spec: ScheduleSpec): RRule {
  const dtstart = new Date(spec.dtstart);
  if (Number.isNaN(dtstart.getTime())) {
    throw new Error("dtstart must be a valid ISO-8601 timestamp.");
  }

  const options = RRule.parseString(spec.rrule);
  if (options.freq === undefined) {
    throw new Error("rrule must include FREQ.");
  }

  options.dtstart = dtstart;
  options.tzid = spec.timezone;
  return new RRule(options);
}

/** Validates and normalizes a raw schedule spec object. */
export function normalizeScheduleSpec(raw: {
  version: string;
  timezone: string;
  dtstart: string;
  rrule: string;
}): ScheduleSpec {
  const version = raw.version.trim();
  if (version !== "v1") {
    throw new Error(`Unsupported schedule spec version '${version}'.`);
  }

  const timezone = raw.timezone.trim();
  const dtstart = raw.dtstart.trim();
  const rrule = raw.rrule.trim().toUpperCase();
  if (!timezone || !dtstart || !rrule) {
    throw new Error("schedule spec requires version, timezone, dtstart, and rrule.");
  }

  const normalized: ScheduleSpec = {
    version: "v1",
    timezone,
    dtstart,
    rrule
  };

  assertTimeZone(normalized.timezone);
  void createRuleFromSpec(normalized);
  return normalized;
}

/** Computes the next run timestamp at/after a given point in time. */
export function computeNextScheduleRunAtMs(spec: ScheduleSpec, afterMs: number): number | undefined {
  const rule = createRuleFromSpec(spec);
  const nextOccurrence = rule.after(new Date(afterMs), true);
  if (!nextOccurrence) {
    return undefined;
  }

  return nextOccurrence.getTime();
}
