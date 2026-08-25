import { describe, expect, test } from "vitest";

import {
  createDelegationCompletionReceipt,
  createDelegationStartReceipt,
  delegationCompletionReceiptPath,
  delegationStartReceiptPath,
  parseDelegationCompletionInput,
  parseDelegationCompletionReceipt,
} from "../../src/workflow/delegation-receipt.js";
import { specialistDelegationFixture } from "../fixtures/specialist-plan-fixture.js";

const PLAN_FINGERPRINT = `sha256:${"a".repeat(64)}` as const;
const RESULT_HASH = `sha256:${"b".repeat(64)}` as const;

describe("Delegation receipts", () => {
  test("creates bounded start and completion receipts bound to the approved contract", () => {
    const start = createDelegationStartReceipt(
      specialistDelegationFixture,
      PLAN_FINGERPRINT,
      new Date("2026-08-25T00:00:00.000Z"),
    );
    const completion = createDelegationCompletionReceipt(specialistDelegationFixture, {
      schemaVersion: 1,
      expertId: specialistDelegationFixture.expertId,
      planFingerprint: PLAN_FINGERPRINT,
      status: "completed",
      summary: "实现与独立验证均已完成。",
      resultHash: RESULT_HASH,
      evidencePointers: [{
        kind: "evidence",
        locator: "quality/runs/TASK-20260824-001/slice-tracer/000002.json",
        contentHash: RESULT_HASH,
      }],
    }, new Date("2026-08-25T01:00:00.000Z"));

    expect(start).toMatchObject({ status: "started", planFingerprint: PLAN_FINGERPRINT });
    expect(completion).toMatchObject({ status: "completed", resultHash: RESULT_HASH });
    expect(Object.isFrozen(completion.evidencePointers)).toBe(true);
    expect(delegationStartReceiptPath(start.workItemId, start.delegationId)).toMatch(/\/start\.json$/u);
    expect(delegationCompletionReceiptPath(start.workItemId, start.delegationId)).toMatch(/\/completion\.json$/u);
  });

  test("rejects sensitive, oversized, duplicate, and evidence-free completion content", () => {
    const base = {
      schemaVersion: 1 as const,
      expertId: specialistDelegationFixture.expertId,
      planFingerprint: PLAN_FINGERPRINT,
      status: "completed" as const,
      summary: "完成。",
      resultHash: RESULT_HASH,
      evidencePointers: [{ kind: "file" as const, locator: "src/result.ts" }],
    };
    expect(() => parseDelegationCompletionInput({ ...base, summary: "Bearer secret-token-value" })).toThrow();
    expect(() => parseDelegationCompletionInput({ ...base, summary: "x".repeat(2_049) })).toThrow();
    expect(() => parseDelegationCompletionInput({ ...base, evidencePointers: [] })).toThrow();
    expect(() => parseDelegationCompletionInput({
      ...base,
      evidencePointers: [base.evidencePointers[0], base.evidencePointers[0]],
    })).toThrow();
  });

  test("rejects tampered persisted receipts", () => {
    expect(() => parseDelegationCompletionReceipt({
      schemaVersion: 1,
      kind: "completion",
      delegationId: specialistDelegationFixture.id,
      expertId: specialistDelegationFixture.expertId,
      workItemId: specialistDelegationFixture.workItemId,
      workSpecId: specialistDelegationFixture.workSpecId,
      workSpecRevision: 0,
      sliceId: specialistDelegationFixture.sliceId,
      planFingerprint: PLAN_FINGERPRINT,
      status: "completed",
      summary: "完成。",
      resultHash: RESULT_HASH,
      evidencePointers: [],
      completedAt: "2026-08-25T01:00:00.000Z",
    })).toThrow();
  });
});
