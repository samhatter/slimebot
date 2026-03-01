type MatrixReplyMessage = {
  type: "matrix.reply";
  roomId: string;
  body: string;
};

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function isMatrixReplyMessage(value: unknown): value is MatrixReplyMessage {
  const record = asRecord(value);
  if (!record) {
    return false;
  }

  return (
    record["type"] === "matrix.reply" &&
    typeof record["roomId"] === "string" &&
    typeof record["body"] === "string"
  );
}

export function getAuthUrlFromLoginResult(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) {
    return undefined;
  }

  const authUrl = record["authUrl"];
  return typeof authUrl === "string" ? authUrl : undefined;
}