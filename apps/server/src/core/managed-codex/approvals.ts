export type ApprovalDecision = "accept" | "decline" | "cancel";
export type ApprovalKind = "commandExecution" | "fileChange" | "userInput" | "toolCall";

export interface ApprovalResponseExtra {
  optionId?: string;
  answers?: Record<string, string | string[]>;
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "accept" || value === "decline" || value === "cancel";
}

export function sanitizeApprovalPayload(
  kind: ApprovalKind,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "commandExecution") {
    return {
      kind: typeof params.kind === "string" ? params.kind : "command",
      command: typeof params.command === "string" ? params.command : null,
      cwd: typeof params.cwd === "string" ? params.cwd : null,
      reason: typeof params.reason === "string" ? params.reason : null,
      itemId: typeof params.itemId === "string" ? params.itemId : null,
    };
  }
  if (kind === "userInput" || kind === "toolCall") {
    return { ...params };
  }
  return {
    reason: typeof params.reason === "string" ? params.reason : null,
    grantRoot: typeof params.grantRoot === "string" ? params.grantRoot : null,
    itemId: typeof params.itemId === "string" ? params.itemId : null,
  };
}
