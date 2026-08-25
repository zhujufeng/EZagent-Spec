import { describe, expect, test } from "vitest";

import { parseWorkContractDraft } from "../../src/workflow/work-contract.js";
import {
  controlledActionDraft,
  genericWorkContractDraft,
} from "../fixtures/work-contract-fixture.js";

describe("Work Contract v2", () => {
  test("accepts one domain-neutral tracer slice without a role enum or expert team", () => {
    const contract = parseWorkContractDraft(genericWorkContractDraft);

    expect(contract.workSpec.mode).toBe("brief");
    expect(contract.workSpec.slicePlan[0]?.id).toBe("slice-tracer");
    expect(contract.specialistAssessment.decision).toBe("not-needed");
    expect(contract).not.toHaveProperty("role");
    expect(contract).not.toHaveProperty("expertTeam");
    expect(Object.isFrozen(contract.workSpec.slicePlan)).toBe(true);
  });

  test("requires an explicit Specialist Assessment for new persisted work", () => {
    const { specialistAssessment: _assessment, ...missing } = genericWorkContractDraft;

    expect(() => parseWorkContractDraft(missing)).toThrow();
  });

  test("binds required capability needs to known Slices", () => {
    expect(() => parseWorkContractDraft({
      ...genericWorkContractDraft,
      specialistAssessment: {
        decision: "required",
        reasons: ["需要隔离分析"],
        needs: [{
          id: "need-analysis",
          sliceId: "slice-missing",
          purpose: "analysis",
          capabilities: ["business-analysis"],
          domains: [],
          projectSignals: [],
          isolationReason: "context-isolation",
        }],
      },
    })).toThrow(/unknown Slice/u);
  });

  test("requires an independent review need for independent-agent and mixed review", () => {
    const controlled = controlledActionDraft();
    expect(() => parseWorkContractDraft({
      ...controlled,
      specialistAssessment: genericWorkContractDraft.specialistAssessment,
    })).toThrow(/review capability need/iu);
  });

  test("rejects external writes that are not Controlled and target-approved", () => {
    const controlled = controlledActionDraft();
    expect(() => parseWorkContractDraft({
      ...controlled,
      workSpec: {
        ...controlled.workSpec,
        mode: "brief",
        approvalPoints: [],
      },
    })).toThrow(/Controlled Mode|Approval Point/u);
  });

  test("rejects Controlled work that delegates final review to the executing Agent", () => {
    const controlled = controlledActionDraft();
    expect(() => parseWorkContractDraft({
      ...controlled,
      workSpec: {
        ...controlled.workSpec,
        reviewPolicy: {
          method: "self",
          reasons: ["由执行 Agent 自审"],
          reviewAfterSlices: 1,
        },
      },
    })).toThrow(/Controlled Mode.*human|mixed/iu);
  });
});
