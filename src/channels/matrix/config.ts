import { asRecord, optionalString, requiredString } from "../../config/parsing.js";

export type MatrixConfig = {
  homeserverUrl: string;
  accessToken: string;
  botUserId?: string;
  allowedInviteSender?: string;
};

export function parseMatrixConfig(value: unknown): MatrixConfig {
  const matrixRecord = asRecord(value);
  if (!matrixRecord) {
    throw new Error("Missing required object 'channel.matrix'");
  }

  return {
    homeserverUrl: requiredString(matrixRecord, "homeserverUrl"),
    accessToken: requiredString(matrixRecord, "accessToken"),
    botUserId: optionalString(matrixRecord, "botUserId"),
    allowedInviteSender: optionalString(matrixRecord, "allowedInviteSender")
  };
}
