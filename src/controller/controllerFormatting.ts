import { asRecord } from "./commands.js";
import { escapeHtml, readStringFromAny, toJsonSnippet } from "./controllerUtils.js";

export function formatJsonResponse(title: string, value: unknown): { body: string; formattedBody?: string } {
  const json = toJsonSnippet(value, 7000);
  return {
    body: `${title}:\n${json}`,
    formattedBody: `<b>${escapeHtml(title)}</b><pre><code>${escapeHtml(json)}</code></pre>`
  };
}

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
