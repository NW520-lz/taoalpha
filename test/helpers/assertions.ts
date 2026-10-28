import assert from "node:assert/strict";
import { DomainError, type ErrorCode } from "../../src/lib/errors.ts";

/** Asserts fn throws a DomainError with the code, and (optionally) a violation matching ruleId and/or field. */
export function expectDomainError(fn: () => unknown, code: ErrorCode, match: { ruleId?: string; field?: string } = {}): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof DomainError, `expected DomainError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (match.ruleId !== undefined || match.field !== undefined) {
      const found = err.violations.some(
        (v) => (match.ruleId === undefined || v.ruleId === match.ruleId) && (match.field === undefined || v.field === match.field),
      );
      assert.ok(found, `no violation matching ${JSON.stringify(match)} in ${JSON.stringify(err.violations)}`);
    }
    return true;
  });
}
