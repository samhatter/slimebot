export function readStringFromAny(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) {
      return value;
    }

    if (typeof value === "number") {
      return String(value);
    }
  }

  return undefined;
}

export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function truncateForMessage(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n... (truncated)`;
}

export function toJsonSnippet(value: unknown, maxLength = 3500): string {
  return truncateForMessage(stringifyJson(value), maxLength);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function getToolActivityKey(threadId: string, itemId: string): string {
  return `${threadId}:${itemId}`;
}

function sanitizeToolPayloadValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const sanitizedArray = value
      .map((entry) => sanitizeToolPayloadValue(entry))
      .filter((entry) => entry !== undefined);

    return sanitizedArray.length > 0 ? sanitizedArray : undefined;
  }

  if (typeof value !== "object" || value === null) {
    return value === null ? undefined : value;
  }

  const record = value as Record<string, unknown>;
  const excludedFields = new Set([
    "id",
    "status",
    "kind",
    "type",
    "phase",
    "threadId",
    "turnId",
    "commandActions",
    "actions"
  ]);

  const sanitizedRecord: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (excludedFields.has(key)) {
      continue;
    }

    const sanitizedValue = sanitizeToolPayloadValue(entryValue);
    if (sanitizedValue !== undefined) {
      sanitizedRecord[key] = sanitizedValue;
    }
  }

  return Object.keys(sanitizedRecord).length > 0 ? sanitizedRecord : undefined;
}

export function extractToolEventSnapshot(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const normalizedType = readStringFromAny(item["type"])?.toLowerCase();
  const sanitizedItem = sanitizeToolPayloadValue(item);
  if (typeof sanitizedItem !== "object" || sanitizedItem === null) {
    return undefined;
  }

  const snapshot = { ...(sanitizedItem as Record<string, unknown>) };

  if (normalizedType === "filechange") {
    const changes = item["changes"];
    if (Array.isArray(changes)) {
      const paths = changes
        .map((change) => readStringFromAny((change as Record<string, unknown> | undefined)?.["path"]))
        .filter((path): path is string => Boolean(path));
      if (paths.length > 0) {
        snapshot["paths"] = paths;
      }
    }
    delete snapshot["changes"];
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

export function describeToolLikeItem(itemType: string, item: Record<string, unknown>): string | undefined {
  const normalizedType = itemType.toLowerCase();

  const ignoredTypes = new Set([
    "usermessage",
    "agentmessage",
    "contextcompaction"
  ]);
  if (ignoredTypes.has(normalizedType)) {
    return undefined;
  }

  if (normalizedType === "commandexecution") {
    const command = item["command"];
    if (Array.isArray(command)) {
      const commandParts = command.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
      if (commandParts.length > 0) {
        return `${itemType}: ${commandParts.join(" ")}`;
      }
    }
    return itemType;
  }

  if (normalizedType === "mcptoolcall") {
    const server = readStringFromAny(item["server"]);
    const tool = readStringFromAny(item["tool"]);
    if (server && tool) {
      return `${itemType} (${server}/${tool})`;
    }
    if (tool) {
      return `${itemType} (${tool})`;
    }
    return itemType;
  }

  if (normalizedType === "collabtoolcall") {
    const tool = readStringFromAny(item["tool"]);
    return tool ? `${itemType} (${tool})` : itemType;
  }

  if (normalizedType === "websearch") {
    const query = readStringFromAny(item["query"]);
    return query ? `${itemType}: ${query}` : itemType;
  }

  if (normalizedType === "imageview") {
    const path = readStringFromAny(item["path"]);
    return path ? `${itemType}: ${path}` : itemType;
  }

  if (normalizedType === "filechange") {
    const changes = item["changes"];
    if (Array.isArray(changes)) {
      return `${itemType} (${changes.length} change${changes.length === 1 ? "" : "s"})`;
    }
    return itemType;
  }

  const hasToolSignals = [
    "toolName",
    "tool_name",
    "recipient_name",
    "recipientName",
    "command",
    "filePath",
    "dirPath",
    "query",
    "url",
    "urls",
    "packageList",
    "method"
  ].some((field) => field in item);

  const typeLooksToolLike = [
    "tool",
    "command",
    "exec",
    "filechange",
    "applypatch",
    "search",
    "read",
    "write",
    "terminal",
    "mcp"
  ].some((token) => normalizedType.includes(token));

  if (!hasToolSignals && !typeLooksToolLike) {
    return undefined;
  }

  const toolName = readStringFromAny(item["toolName"], item["tool_name"], item["recipient_name"], item["recipientName"]);
  if (toolName) {
    return `${itemType} (${toolName})`;
  }

  const command = item["command"];
  if (typeof command === "string" && command.trim()) {
    return `${itemType}: ${command.trim()}`;
  }

  if (Array.isArray(command)) {
    const commandParts = command.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    if (commandParts.length > 0) {
      return `${itemType}: ${commandParts.join(" ")}`;
    }
  }

  const method = readStringFromAny(item["method"]);
  if (method) {
    return `${itemType} (${method})`;
  }

  return itemType;
}
