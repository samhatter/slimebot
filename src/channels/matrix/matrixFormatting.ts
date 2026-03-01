/**
 * @fileoverview Matrix-specific response formatting helpers (plain + HTML).
 */

import type {
  ChannelApprovalRequest,
  ChannelThreadStatusView,
  ChannelToolActivityCompleted,
  ChannelToolActivityStarted
} from "../channel.js";

/** Safely narrows unknown values into record-like objects. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

/** Returns the first non-empty string/number value as a string. */
function readStringFromAny(...values: Array<unknown>): string | undefined {
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

/** Safely stringifies arbitrary JSON-like values. */
function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Truncates a long string to the given max length with marker suffix. */
function truncateForMessage(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n... (truncated)`;
}

/** Builds a JSON snippet string with truncation applied. */
function toJsonSnippet(value: unknown, maxLength = 3500): string {
  return truncateForMessage(stringifyJson(value), maxLength);
}

/** Escapes HTML special characters for safe Matrix rich message rendering. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Formats an arbitrary JSON response into plain text and HTML message bodies. */
export function formatJsonResponse(title: string, value: unknown): { body: string; formattedBody?: string } {
  const json = toJsonSnippet(value, 7000);
  return {
    body: `${title}:\n${json}`,
    formattedBody: `<b>${escapeHtml(title)}</b><pre><code>${escapeHtml(json)}</code></pre>`
  };
}

/** Formats help output into plain text and HTML list output. */
export function formatHelp(lines: string[]): { body: string; formattedBody?: string } {
  const formattedBody = [
    "<b>Available commands</b>",
    "<ul>",
    ...lines.slice(1).map((line) => {
      const [command, ...descriptionParts] = line.slice(2).split(":");
      const description = descriptionParts.join(":").trim();
      return `<li><code>${escapeHtml(command.trim())}</code>: ${escapeHtml(description)}</li>`;
    }),
    "</ul>"
  ].join("");

  return {
    body: lines.join("\n"),
    formattedBody
  };
}

/** Formats a thread list response into plain text and HTML table output. */
export function formatThreadList(result: unknown, archived: boolean): { body: string; formattedBody?: string } {
  const record = asRecord(result);
  const data = record?.["data"];
  if (!Array.isArray(data) || data.length === 0) {
    const emptyMessage = archived ? "No archived threads found." : "No threads found.";
    return {
      body: emptyMessage,
      formattedBody: `<p>${escapeHtml(emptyMessage)}</p>`
    };
  }

  const entries = data
    .slice(0, 20)
    .map((item) => {
      const entry = asRecord(item);
      const threadId = readStringFromAny(entry?.["id"]) ?? "<unknown>";
      const name = readStringFromAny(entry?.["name"]);
      const preview = readStringFromAny(entry?.["preview"]);
      const updatedAt = readStringFromAny(entry?.["updatedAt"], entry?.["createdAt"]);
      const modelProvider = readStringFromAny(entry?.["modelProvider"]);
      const statusType = readStringFromAny(asRecord(entry?.["status"])?.["type"]);

      return {
        threadId,
        name,
        preview,
        updatedAt,
        modelProvider,
        statusType
      };
    });

  const lines = entries
    .map((entry, index) => {
      const { threadId, name, preview, updatedAt, modelProvider, statusType } = entry;

      return `${index + 1}. ${threadId} | ${name ?? "-"} | ${preview ?? "-"} | ${updatedAt ?? "-"} | ${modelProvider ?? "-"} | ${statusType ?? "-"}`;
    })
    .join("\n");

  const heading = `${archived ? "Archived" : "Active"} threads:`;
  const formattedBody = [
    `<b>${escapeHtml(archived ? "Archived" : "Active")} threads</b>`,
    "<table>",
    "<thead><tr><th>#</th><th>Thread ID</th><th>Name</th><th>Preview</th><th>Updated</th><th>Provider</th><th>Status</th></tr></thead>",
    "<tbody>",
    ...entries.map(
      ({ threadId, name, preview, updatedAt, modelProvider, statusType }, index) =>
        `<tr><td>${index + 1}</td><td><code>${escapeHtml(threadId)}</code></td><td>${escapeHtml(name ?? "-")}</td><td>${escapeHtml(preview ?? "-")}</td><td>${escapeHtml(updatedAt ?? "-")}</td><td>${escapeHtml(modelProvider ?? "-")}</td><td>${escapeHtml(statusType ?? "-")}</td></tr>`
    ),
    "</tbody>",
    "</table>"
  ].join("");

  return {
    body: `${heading}\n${lines}`,
    formattedBody
  };
}

/** Formats a model list response into plain text and HTML table output. */
export function formatModelList(result: unknown): { body: string; formattedBody?: string } {
  const record = asRecord(result);
  const data = record?.["data"];
  if (!Array.isArray(data)) {
    return formatJsonResponse("Model response", result);
  }

  const entries = data
    .slice(0, 40)
    .map((item) => {
      const entry = asRecord(item);
      const modelId = readStringFromAny(entry?.["id"], entry?.["model"]);

      if (!modelId) {
        return undefined;
      }

      const displayName = readStringFromAny(entry?.["displayName"]) ?? "-";
      const defaultReasoningEffort = readStringFromAny(entry?.["defaultReasoningEffort"]) ?? "-";
      const upgrade = readStringFromAny(entry?.["upgrade"]) ?? "-";

      const inputModalitiesRaw = entry?.["inputModalities"];
      const inputModalities = Array.isArray(inputModalitiesRaw)
        ? inputModalitiesRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : ["text", "image"];

      const hidden = entry?.["hidden"] === true ? "yes" : "no";
      const isDefault = entry?.["isDefault"] === true ? "yes" : "no";

      return {
        modelId,
        displayName,
        defaultReasoningEffort,
        upgrade,
        inputModalities,
        hidden,
        isDefault
      };
    })
    .filter(
      (
        entry
      ): entry is {
        modelId: string;
        displayName: string;
        defaultReasoningEffort: string;
        upgrade: string;
        inputModalities: string[];
        hidden: string;
        isDefault: string;
      } => Boolean(entry)
    );

  if (entries.length === 0) {
    return formatJsonResponse("Model response", result);
  }

  const lines = [
    "Available models:",
    ...entries.map(
      (entry, index) =>
        `${index + 1}. ${entry.modelId} | ${entry.displayName} | ${entry.defaultReasoningEffort} | ${entry.inputModalities.join(", ")} | ${entry.isDefault} | ${entry.hidden}${entry.upgrade !== "-" ? ` | ${entry.upgrade}` : ""}`
    )
  ];

  const formattedBody = [
    "<b>Available models</b>",
    "<table>",
    "<thead><tr><th>#</th><th>Model</th><th>Name</th><th>Default Effort</th><th>Input Modalities</th><th>Default</th><th>Hidden</th><th>Upgrade</th></tr></thead>",
    "<tbody>",
    ...entries.map(
      (entry, index) =>
        `<tr><td>${index + 1}</td><td><code>${escapeHtml(entry.modelId)}</code></td><td>${escapeHtml(entry.displayName)}</td><td>${escapeHtml(entry.defaultReasoningEffort)}</td><td>${escapeHtml(entry.inputModalities.join(", "))}</td><td>${escapeHtml(entry.isDefault)}</td><td>${escapeHtml(entry.hidden)}</td><td>${entry.upgrade !== "-" ? `<code>${escapeHtml(entry.upgrade)}</code>` : "-"}</td></tr>`
    ),
    "</tbody>",
    "</table>"
  ].join("");

  return {
    body: lines.join("\n"),
    formattedBody
  };
}

/** Formats thread status details into plain text and HTML list output. */
export function formatThreadStatus(input: ChannelThreadStatusView): { body: string; formattedBody?: string } {
  const body = [
    `Thread status for ${input.threadId}:`,
    `name: ${input.name}`,
    `preview: ${input.preview}`,
    `updated: ${input.updatedAt}`,
    `provider: ${input.modelProvider}`,
    `selected model: ${input.selectedModel}`,
    `status: ${input.statusType}`,
    `agent nickname: ${input.agentNickname}`,
    `agent role: ${input.agentRole}`,
    `total thread token usage (input/output/total): ${input.totalInputTokens ?? "-"}/${input.totalOutputTokens ?? "-"}/${input.totalTokens ?? "-"}`,
    `last token usage (input/output/total): ${input.lastInputTokens ?? "-"}/${input.lastOutputTokens ?? "-"}/${input.lastTotalTokens ?? "-"}`,
    `archived: ${input.archived}`,
    `default reasoning: ${input.defaultEffort}`
  ].join("\n");

  const formattedBody = [
    "<b>Thread status</b>",
    "<ul>",
    `<li><b>threadId:</b> <code>${escapeHtml(input.threadId)}</code></li>`,
    `<li><b>name:</b> ${escapeHtml(input.name)}</li>`,
    `<li><b>preview:</b> ${escapeHtml(input.preview)}</li>`,
    `<li><b>updated:</b> ${escapeHtml(input.updatedAt)}</li>`,
    `<li><b>provider:</b> ${escapeHtml(input.modelProvider)}</li>`,
    `<li><b>selected model:</b> ${escapeHtml(input.selectedModel)}</li>`,
    `<li><b>status:</b> ${escapeHtml(input.statusType)}</li>`,
    `<li><b>agent nickname:</b> ${escapeHtml(input.agentNickname)}</li>`,
    `<li><b>agent role:</b> ${escapeHtml(input.agentRole)}</li>`,
    `<li><b>total thread token usage (input/output/total):</b> ${escapeHtml(String(input.totalInputTokens ?? "-"))}/${escapeHtml(String(input.totalOutputTokens ?? "-"))}/${escapeHtml(String(input.totalTokens ?? "-"))}</li>`,
    `<li><b>last token usage (input/output/total):</b> ${escapeHtml(String(input.lastInputTokens ?? "-"))}/${escapeHtml(String(input.lastOutputTokens ?? "-"))}/${escapeHtml(String(input.lastTotalTokens ?? "-"))}</li>`,
    `<li><b>archived:</b> ${escapeHtml(input.archived)}</li>`,
    `<li><b>default reasoning:</b> ${escapeHtml(input.defaultEffort)}</li>`,
    "</ul>"
  ].join("");

  return {
    body,
    formattedBody
  };
}

/** Formats approval requests into plain text and HTML list output. */
export function formatApprovalRequest(request: ChannelApprovalRequest): { body: string; formattedBody?: string } {
  const formattedBody = [
    `<b>Approval requested for ${escapeHtml(request.approvalType)}</b>`,
    "<ul>",
    `<li><b>threadId:</b> <code>${escapeHtml(request.threadId)}</code></li>`,
    `<li><b>turnId:</b> <code>${escapeHtml(request.turnId)}</code></li>`,
    `<li><b>itemId:</b> <code>${escapeHtml(request.itemId)}</code></li>`,
    request.commandPreview ? `<li><b>command:</b> <code>${escapeHtml(request.commandPreview)}</code></li>` : undefined,
    request.reason ? `<li><b>reason:</b> ${escapeHtml(request.reason)}</li>` : undefined,
    "</ul>",
    "<p>Reply with <code>!approve</code> (<code>!a</code>) to approve, or <code>!skip</code> (<code>!s</code>) to decline.</p>"
  ]
    .filter((line): line is string => typeof line === "string")
    .join("");

  const body = [
    `Approval requested for ${request.approvalType}.`,
    `threadId: ${request.threadId}`,
    `turnId: ${request.turnId}`,
    `itemId: ${request.itemId}`,
    request.commandPreview ? `command: ${request.commandPreview}` : undefined,
    request.reason ? `reason: ${request.reason}` : undefined,
    "Reply with !approve (!a) to approve, or !skip (!s) to decline."
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");

  return {
    body,
    formattedBody
  };
}

/** Formats tool-start activity notifications into plain text and HTML output. */
export function formatToolActivityStarted(activity: ChannelToolActivityStarted): { body: string; formattedBody?: string } {
  const snapshotJson = activity.snapshot ? toJsonSnippet(activity.snapshot, 1800) : undefined;
  const body = [
    `Tool: ${activity.itemType}`,
    snapshotJson
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const formattedBody = [
    `<p><b>Tool:</b> ${escapeHtml(activity.itemType)}</p>`,
    snapshotJson
      ? `<pre><code>${escapeHtml(snapshotJson)}</code></pre>`
      : ""
  ].join("");

  return {
    body,
    formattedBody
  };
}

/** Formats tool completion notifications into plain text and HTML output. */
export function formatToolActivityCompleted(activity: ChannelToolActivityCompleted): { body: string; formattedBody?: string } {
  const snapshotJson = activity.snapshot ? toJsonSnippet(activity.snapshot, 1800) : undefined;
  const body = [
    `${activity.completionLabel}: ${activity.itemType} (${activity.elapsedSeconds}s)`,
    activity.itemError ? `error: ${activity.itemError}` : undefined,
    snapshotJson
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const formattedBody = [
    `<p><b>${escapeHtml(activity.completionLabel)}:</b> ${escapeHtml(activity.itemType)} (${escapeHtml(activity.elapsedSeconds)}s)</p>`,
    activity.itemError ? `<p><b>error:</b> ${escapeHtml(activity.itemError)}</p>` : "",
    snapshotJson
      ? `<pre><code>${escapeHtml(snapshotJson)}</code></pre>`
      : ""
  ].join("");

  return {
    body,
    formattedBody
  };
}

/** Formats compaction completion notifications into plain text and HTML output. */
export function formatCompactionCompleted(threadId: string, turnId?: string): { body: string; formattedBody?: string } {
  const body = turnId
    ? `Compaction completed for ${threadId} (turn ${turnId}).`
    : `Compaction completed for ${threadId}.`;

  const formattedBody = [
    "<b>Compaction completed</b>",
    "<ul>",
    `<li><b>threadId:</b> <code>${escapeHtml(threadId)}</code></li>`,
    turnId ? `<li><b>turnId:</b> <code>${escapeHtml(turnId)}</code></li>` : "",
    "</ul>"
  ].join("");

  return {
    body,
    formattedBody
  };
}

