export type ErrorCode =
  | "INVALID_INPUT"
  | "DATA_NOT_READY"
  | "IDEMPOTENCY_CONFLICT"
  | "UNSUPPORTED_CAPABILITY"
  | "DEPENDENCY_UNAVAILABLE"
  | "PERSISTENCE_UNAVAILABLE";

export interface Violation {
  ruleId: string;
  field?: string;
  evidenceRef?: string;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly violations: Violation[];

  constructor(code: ErrorCode, message: string, violations: Violation[] = []) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.violations = violations;
  }
}
