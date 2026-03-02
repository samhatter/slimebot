type JsonRecord = Record<string, unknown>;

export type RequestId = string | number;

export type ThreadItem = JsonRecord & {
  type: string;
  id?: string;
  text?: string;
  error?: unknown;
};

export type Turn = {
  id: string;
  items: ThreadItem[];
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: unknown | null;
};

export type AccountLoginCompletedNotification = {
  loginId: string | null;
  success: boolean;
  error: string | null;
};

export type TurnStartedNotification = {
  threadId: string;
  turn: Turn;
};

export type TurnCompletedNotification = {
  threadId: string;
  turn: Turn;
};

export type ModelReroutedNotification = {
  threadId: string;
  turnId: string;
  fromModel: string;
  toModel: string;
  reason: "highRiskCyberActivity";
};

export type ThreadTokenUsage = {
  total: JsonRecord;
  last: JsonRecord;
  modelContextWindow: number | null;
};

export type ThreadTokenUsageUpdatedNotification = {
  threadId: string;
  turnId: string;
  tokenUsage: ThreadTokenUsage;
};

export type AccountRateLimitsUpdatedNotification = {
  rateLimits: JsonRecord;
};

export type ItemStartedNotification = {
  item: ThreadItem;
  threadId: string;
  turnId: string;
};

export type ItemCompletedNotification = {
  item: ThreadItem;
  threadId: string;
  turnId: string;
};

export type ServerRequestResolvedNotification = {
  threadId: string;
  requestId: RequestId;
};

export type ServerNotification =
  | { method: "account/login/completed"; params: AccountLoginCompletedNotification }
  | { method: "turn/started"; params: TurnStartedNotification }
  | { method: "turn/completed"; params: TurnCompletedNotification }
  | { method: "model/rerouted"; params: ModelReroutedNotification }
  | { method: "thread/tokenUsage/updated"; params: ThreadTokenUsageUpdatedNotification }
  | { method: "account/rateLimits/updated"; params: AccountRateLimitsUpdatedNotification }
  | { method: "item/started"; params: ItemStartedNotification }
  | { method: "item/completed"; params: ItemCompletedNotification }
  | { method: "serverRequest/resolved"; params: ServerRequestResolvedNotification };

export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: JsonRecord } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: JsonRecord } }
  | "decline"
  | "cancel";

export type CommandExecutionRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  networkApprovalContext?: JsonRecord | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: JsonRecord[] | null;
  additionalPermissions?: JsonRecord | null;
  proposedExecpolicyAmendment?: JsonRecord | null;
  proposedNetworkPolicyAmendments?: JsonRecord[] | null;
  availableDecisions?: CommandExecutionApprovalDecision[] | null;
};

export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type FileChangeRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
};

export type TokenUsageCounts = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type ThreadReadTokenUsage = {
  total: TokenUsageCounts;
  last: TokenUsageCounts;
  modelContextWindow: number | null;
};

export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export type ThreadReadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: ThreadActiveFlag[] };

export type ThreadSourceKind =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | "subAgent"
  | "subAgentReview"
  | "subAgentCompact"
  | "subAgentThreadSpawn"
  | "subAgentOther"
  | "unknown";

export type ThreadReadThread = {
  id: string;
  preview: string;
  ephemeral?: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: ThreadReadStatus;
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: ThreadSourceKind;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: JsonRecord | null;
  name: string | null;
  turns: Turn[];
};

export type ThreadReadResult = {
  thread: ThreadReadThread;
};

export type ServerRequest =
  | { method: "item/commandExecution/requestApproval"; id: RequestId; params: CommandExecutionRequestApprovalParams }
  | { method: "item/fileChange/requestApproval"; id: RequestId; params: FileChangeRequestApprovalParams };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

function isTurn(value: unknown): value is Turn {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["id"] === "string"
    && Array.isArray(value["items"])
    && typeof value["status"] === "string"
    && Object.hasOwn(value, "error")
  );
}

function isThreadItem(value: unknown): value is ThreadItem {
  return isRecord(value) && typeof value["type"] === "string";
}

function isAccountLoginCompletedNotification(value: unknown): value is AccountLoginCompletedNotification {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (typeof value["loginId"] === "string" || value["loginId"] === null)
    && typeof value["success"] === "boolean"
    && (typeof value["error"] === "string" || value["error"] === null)
  );
}

function isTurnStartedNotification(value: unknown): value is TurnStartedNotification {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["threadId"] === "string" && isTurn(value["turn"]);
}

function isTurnCompletedNotification(value: unknown): value is TurnCompletedNotification {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["threadId"] === "string" && isTurn(value["turn"]);
}

function isModelReroutedNotification(value: unknown): value is ModelReroutedNotification {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["threadId"] === "string"
    && typeof value["turnId"] === "string"
    && typeof value["fromModel"] === "string"
    && typeof value["toModel"] === "string"
    && value["reason"] === "highRiskCyberActivity"
  );
}

function isThreadTokenUsageUpdatedNotification(value: unknown): value is ThreadTokenUsageUpdatedNotification {
  if (!isRecord(value)) {
    return false;
  }

  const tokenUsage = value["tokenUsage"];
  if (!isRecord(tokenUsage)) {
    return false;
  }

  return (
    typeof value["threadId"] === "string"
    && typeof value["turnId"] === "string"
    && isRecord(tokenUsage["total"])
    && isRecord(tokenUsage["last"])
    && (typeof tokenUsage["modelContextWindow"] === "number" || tokenUsage["modelContextWindow"] === null)
  );
}

function isAccountRateLimitsUpdatedNotification(value: unknown): value is AccountRateLimitsUpdatedNotification {
  return isRecord(value) && isRecord(value["rateLimits"]);
}

function isItemStartedNotification(value: unknown): value is ItemStartedNotification {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["threadId"] === "string"
    && typeof value["turnId"] === "string"
    && isThreadItem(value["item"])
  );
}

function isItemCompletedNotification(value: unknown): value is ItemCompletedNotification {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["threadId"] === "string"
    && typeof value["turnId"] === "string"
    && isThreadItem(value["item"])
  );
}

function isServerRequestResolvedNotification(value: unknown): value is ServerRequestResolvedNotification {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["threadId"] === "string" && isRequestId(value["requestId"]);
}

function isCommandExecutionRequestApprovalParams(value: unknown): value is CommandExecutionRequestApprovalParams {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["threadId"] === "string"
    && typeof value["turnId"] === "string"
    && typeof value["itemId"] === "string"
  );
}

function isFileChangeRequestApprovalParams(value: unknown): value is FileChangeRequestApprovalParams {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["threadId"] === "string"
    && typeof value["turnId"] === "string"
    && typeof value["itemId"] === "string"
  );
}

function isTokenUsageCounts(value: unknown): value is TokenUsageCounts {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["totalTokens"] === "number"
    && typeof value["inputTokens"] === "number"
    && typeof value["cachedInputTokens"] === "number"
    && typeof value["outputTokens"] === "number"
    && typeof value["reasoningOutputTokens"] === "number"
  );
}

function isThreadReadTokenUsage(value: unknown): value is ThreadReadTokenUsage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isTokenUsageCounts(value["total"])
    && isTokenUsageCounts(value["last"])
    && (typeof value["modelContextWindow"] === "number"
      || value["modelContextWindow"] === null)
  );
}

function isThreadActiveFlag(value: unknown): value is ThreadActiveFlag {
  return value === "waitingOnApproval" || value === "waitingOnUserInput";
}

function isThreadReadStatus(value: unknown): value is ThreadReadStatus {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    return false;
  }

  const statusType = value["type"];
  if (statusType === "notLoaded" || statusType === "idle" || statusType === "systemError") {
    return true;
  }

  if (statusType !== "active") {
    return false;
  }

  const activeFlags = value["activeFlags"];
  return Array.isArray(activeFlags) && activeFlags.every((flag) => isThreadActiveFlag(flag));
}

function isThreadSourceKind(value: unknown): value is ThreadSourceKind {
  return value === "cli"
    || value === "vscode"
    || value === "exec"
    || value === "appServer"
    || value === "subAgent"
    || value === "subAgentReview"
    || value === "subAgentCompact"
    || value === "subAgentThreadSpawn"
    || value === "subAgentOther"
    || value === "unknown";
}

function isThreadReadThread(value: unknown): value is ThreadReadThread {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["id"] === "string"
    && typeof value["preview"] === "string"
    && (typeof value["ephemeral"] === "boolean" || value["ephemeral"] === undefined)
    && typeof value["modelProvider"] === "string"
    && typeof value["createdAt"] === "number"
    && typeof value["updatedAt"] === "number"
    && isThreadReadStatus(value["status"])
    && (typeof value["path"] === "string" || value["path"] === null)
    && typeof value["cwd"] === "string"
    && typeof value["cliVersion"] === "string"
    && isThreadSourceKind(value["source"])
    && (typeof value["agentNickname"] === "string" || value["agentNickname"] === null)
    && (typeof value["agentRole"] === "string" || value["agentRole"] === null)
    && (isRecord(value["gitInfo"]) || value["gitInfo"] === null)
    && (typeof value["name"] === "string" || value["name"] === null)
    && Array.isArray(value["turns"])
    && value["turns"].every((turn) => isTurn(turn))
  );
}

function isThreadReadResult(value: unknown): value is ThreadReadResult {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isThreadReadThread(value["thread"])
  );
}

export function parseCodexServerNotification(message: unknown): ServerNotification | undefined {
  if (!isRecord(message) || typeof message["method"] !== "string") {
    return undefined;
  }

  const method = message["method"];
  const params = message["params"];

  switch (method) {
    case "account/login/completed":
      return isAccountLoginCompletedNotification(params) ? { method, params } : undefined;
    case "turn/started":
      return isTurnStartedNotification(params) ? { method, params } : undefined;
    case "turn/completed":
      return isTurnCompletedNotification(params) ? { method, params } : undefined;
    case "model/rerouted":
      return isModelReroutedNotification(params) ? { method, params } : undefined;
    case "thread/tokenUsage/updated":
      return isThreadTokenUsageUpdatedNotification(params) ? { method, params } : undefined;
    case "account/rateLimits/updated":
      return isAccountRateLimitsUpdatedNotification(params) ? { method, params } : undefined;
    case "item/started":
      return isItemStartedNotification(params) ? { method, params } : undefined;
    case "item/completed":
      return isItemCompletedNotification(params) ? { method, params } : undefined;
    case "serverRequest/resolved":
      return isServerRequestResolvedNotification(params) ? { method, params } : undefined;
    default:
      return undefined;
  }
}

export function parseCodexServerRequest(
  requestId: unknown,
  method: unknown,
  params: unknown
): ServerRequest | undefined {
  if (!isRequestId(requestId) || typeof method !== "string") {
    return undefined;
  }

  if (method === "item/commandExecution/requestApproval" && isCommandExecutionRequestApprovalParams(params)) {
    return { method, id: requestId, params };
  }

  if (method === "item/fileChange/requestApproval" && isFileChangeRequestApprovalParams(params)) {
    return { method, id: requestId, params };
  }

  return undefined;
}

export function parseThreadReadResult(value: unknown): ThreadReadResult | undefined {
  return isThreadReadResult(value) ? value : undefined;
}

export function getAgentMessageFromItemCompleted(notification: ItemCompletedNotification): { threadId: string; body: string } | undefined {
  const { item } = notification;
  if (item.type !== "agentMessage" || typeof item.text !== "string") {
    return undefined;
  }

  const body = item.text.trim();
  if (!body) {
    return undefined;
  }

  return {
    threadId: notification.threadId,
    body
  };
}
