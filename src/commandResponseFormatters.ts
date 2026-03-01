import { asRecord } from "./controllerParsers.js";

export type TableMessagePayload = {
  body: string;
  formattedBody: string;
};

export type TableSpec = {
  headers: string[];
  rows: string[][];
};

export function getModelsTableSpec(result: unknown): TableSpec {
  const modelsValue = findModelArray(result);
  if (!modelsValue) {
    return {
      headers: [],
      rows: []
    };
  }

  const rows = modelsValue
    .map((entry) => {
      if (typeof entry === "string") {
        return [entry, entry, entry, "", "", "", "", "", "", ""];
      }

      const record = asRecord(entry);
      if (!record) {
        return undefined;
      }

      const id = readFirstString(record, ["id", "model", "slug"]) ?? "";
      const model = readFirstString(record, ["model", "id", "slug"]) ?? "";
      const displayName = readFirstString(record, ["displayName", "display_name", "name", "title"]) ?? "";
      const defaultReasoningEffort = readFirstString(record, ["defaultReasoningEffort", "default_reasoning_effort"]) ?? "";
      const inputModalities = readStringArray(record["inputModalities"] ?? record["input_modalities"]).join(", ");
      const supportsPersonality = readBooleanAsString(record["supportsPersonality"] ?? record["supports_personality"]);
      const isDefault = readBooleanAsString(record["isDefault"] ?? record["is_default"]);
      const upgrade = readNullableString(record["upgrade"]);
      const hidden = readBooleanAsString(record["hidden"]);
      const reasoningEfforts = readReasoningEfforts(record["supportedReasoningEfforts"] ?? record["supported_reasoning_efforts"]);

      if (!id && !model && !displayName) {
        return undefined;
      }

      return [
        id,
        model,
        displayName,
        defaultReasoningEffort,
        inputModalities,
        supportsPersonality,
        isDefault,
        upgrade,
        hidden,
        reasoningEfforts
      ];
    })
    .filter((row): row is string[] => Boolean(row));

  return {
    headers: [
      "id",
      "model",
      "displayName",
      "defaultReasoningEffort",
      "inputModalities",
      "supportsPersonality",
      "isDefault",
      "upgrade",
      "hidden",
      "supportedReasoningEfforts"
    ],
    rows
  };
}

export function getAccountRows(result: unknown): string[][] {
  const record = asRecord(result);
  if (!record) {
    return [];
  }

  const accountRecord = asRecord(record["account"]);
  const fromRootOrAccount = (key: string): string | undefined => {
    const rootValue = record[key];
    if (typeof rootValue === "string" && rootValue.trim()) {
      return rootValue;
    }

    const accountValue = accountRecord?.[key];
    if (typeof accountValue === "string" && accountValue.trim()) {
      return accountValue;
    }

    return undefined;
  };

  const requiresAuthValue = record["requiresOpenaiAuth"];
  const requiresAuth = typeof requiresAuthValue === "boolean" ? String(requiresAuthValue) : undefined;

  return [
    fromRootOrAccount("userId") ? ["userId", fromRootOrAccount("userId") ?? ""] : undefined,
    fromRootOrAccount("email") ? ["email", fromRootOrAccount("email") ?? ""] : undefined,
    fromRootOrAccount("type") ? ["type", fromRootOrAccount("type") ?? ""] : undefined,
    fromRootOrAccount("status") ? ["status", fromRootOrAccount("status") ?? ""] : undefined,
    fromRootOrAccount("organization") ? ["organization", fromRootOrAccount("organization") ?? ""] : undefined,
    fromRootOrAccount("planType") ? ["planType", fromRootOrAccount("planType") ?? ""] : undefined,
    requiresAuth ? ["requiresOpenaiAuth", requiresAuth] : undefined
  ].filter((row): row is string[] => Boolean(row));
}

export function flattenToRows(value: unknown, prefix = "", depth = 0): string[][] {
  if (depth > 2) {
    return prefix ? [[prefix, formatCompactJson(value)]] : [];
  }

  const record = asRecord(value);
  if (!record) {
    if (Array.isArray(value)) {
      return prefix ? [[prefix, formatCompactJson(value)]] : [];
    }

    if (!prefix) {
      return [];
    }

    return [[prefix, formatScalar(value)]];
  }

  const rows: string[][] = [];
  for (const [key, nestedValue] of Object.entries(record)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    const nestedRecord = asRecord(nestedValue);
    if (nestedRecord) {
      rows.push(...flattenToRows(nestedRecord, nextPrefix, depth + 1));
      continue;
    }

    if (Array.isArray(nestedValue)) {
      rows.push([nextPrefix, formatCompactJson(nestedValue)]);
      continue;
    }

    rows.push([nextPrefix, formatScalar(nestedValue)]);
  }

  return rows;
}

export function formatCompactJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) {
      return String(value);
    }

    return json.length > 350 ? `${json.slice(0, 347)}...` : json;
  } catch {
    return String(value);
  }
}

export function buildTableMessage(title: string, headers: string[], rows: string[][]): TableMessagePayload {
  const body = [title, buildMarkdownTable(headers, rows)].join("\n");
  const formattedBody = `<p>${escapeHtml(title)}</p>${buildHtmlTable(headers, rows)}`;
  return { body, formattedBody };
}

function findModelArray(value: unknown, depth = 0): unknown[] | undefined {
  if (depth > 4) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const hasModelLikeEntry = value.some((entry) => {
      if (typeof entry === "string") {
        return true;
      }

      const record = asRecord(entry);
      if (!record) {
        return false;
      }

      return Boolean(readFirstString(record, ["id", "model", "name", "displayName", "display_name"]));
    });

    return hasModelLikeEntry ? value : undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const prioritizedKeys = ["models", "items", "data", "results", "list"];
  for (const key of prioritizedKeys) {
    const nested = record[key];
    const found = findModelArray(nested, depth + 1);
    if (found) {
      return found;
    }
  }

  for (const nested of Object.values(record)) {
    const found = findModelArray(nested, depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
}

function readBooleanAsString(value: unknown): string {
  return typeof value === "boolean" ? String(value) : "";
}

function readNullableString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return "null";
  }

  return "";
}

function readReasoningEfforts(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  const efforts = value
    .map((entry) => {
      const record = asRecord(entry);
      const effort = record?.["reasoningEffort"];
      return typeof effort === "string" ? effort : undefined;
    })
    .filter((entry): entry is string => Boolean(entry));

  return efforts.join(", ");
}

function formatScalar(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  return formatCompactJson(value);
}

function buildMarkdownTable(headers: string[], rows: string[][]): string {
  const safeHeaders = headers.map((header) => escapeTableCell(header));
  const safeRows = rows.map((row) => headers.map((_, index) => escapeTableCell(row[index] ?? "")));
  const headerRow = `| ${safeHeaders.join(" | ")} |`;
  const dividerRow = `| ${headers.map(() => "---").join(" | ")} |`;
  const dataRows = safeRows.map((row) => `| ${row.join(" | ")} |`);
  return [headerRow, dividerRow, ...dataRows].join("\n");
}

function buildHtmlTable(headers: string[], rows: string[][]): string {
  const headerCells = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const bodyRows = rows
    .map((row) => {
      const cells = headers
        .map((_, index) => `<td>${escapeHtml((row[index] ?? "").trim())}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ").trim();
}
