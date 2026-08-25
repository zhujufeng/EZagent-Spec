import { describe, expect, test } from "vitest";

import {
  createSpecialistPlanV2,
  parseSpecialistPlanV2,
  serializeSpecialistPlanV2,
  specialistPlanHistoryPath,
} from "../../src/workflow/specialist-plan.js";
import {
  notNeededSpecialistPlanInput,
  requiredSpecialistPlanInput,
} from "../fixtures/specialist-plan-fixture.js";

describe("SpecialistPlanV2", () => {
  test("round-trips a canonical required plan and detects fingerprint drift", () => {
    const plan = createSpecialistPlanV2(requiredSpecialistPlanInput);
    const parsed = parseSpecialistPlanV2(JSON.parse(serializeSpecialistPlanV2(plan)) as unknown);

    expect(parsed).toEqual(plan);
    expect(plan.planFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(plan.assessment.needs)).toBe(true);
    expect(() => parseSpecialistPlanV2({
      ...plan,
      planFingerprint: `sha256:${"0".repeat(64)}`,
    })).toThrow(/fingerprint/u);
  });

  test("accepts an explicit no-Specialist decision without members", () => {
    const plan = createSpecialistPlanV2(notNeededSpecialistPlanInput);

    expect(plan.assessment.decision).toBe("not-needed");
    expect(plan.assessment.needs).toEqual([]);
    expect(plan.delegations).toEqual([]);
  });

  test("rejects invalid assessment and delegation relationships", () => {
    expect(() => createSpecialistPlanV2({
      ...notNeededSpecialistPlanInput,
      assessment: {
        ...notNeededSpecialistPlanInput.assessment,
        needs: requiredSpecialistPlanInput.assessment.needs,
      },
    })).toThrow(/not-needed/u);

    expect(() => createSpecialistPlanV2({
      ...requiredSpecialistPlanInput,
      assessment: {
        ...requiredSpecialistPlanInput.assessment,
        expertId: "ezagent.injected.by-model",
      } as never,
    })).toThrow();

    expect(() => createSpecialistPlanV2({
      ...requiredSpecialistPlanInput,
      delegations: requiredSpecialistPlanInput.delegations.map((delegation) => (
        delegation.mode === "review"
          ? { ...delegation, expertId: "ezagent.engineering.frontend-developer" }
          : delegation
      )),
    })).toThrow(/independent reviewer/u);

    expect(() => createSpecialistPlanV2({
      ...requiredSpecialistPlanInput,
      delegations: [{
        ...requiredSpecialistPlanInput.delegations[0]!,
        sliceId: "slice-other",
      }],
    })).toThrow(/Slice/u);
  });

  test("uses a bounded immutable history path", () => {
    expect(specialistPlanHistoryPath("TASK-20260825-001", 1))
      .toBe("experts/plans/TASK-20260825-001/000001.json");
    expect(() => specialistPlanHistoryPath("../TASK-20260825-001", 1)).toThrow(/Task/u);
    expect(() => specialistPlanHistoryPath("TASK-20260825-001", 0)).toThrow(/revision/u);
  });
});
