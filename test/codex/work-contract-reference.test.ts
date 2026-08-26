import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { parseRuntimeCatalog } from "../../src/experts/runtime-catalog.js";
import { parseWorkContractDraft } from "../../src/workflow/work-contract.js";
import { proposeSpecialistPlanV2 } from "../../src/workflow/specialist-selection.js";

const REFERENCE_PATH = fileURLToPath(new URL(
  "../../plugins/ezagent-spec/skills/ezagent-spec/references/work-contract-v2.md",
  import.meta.url,
));
const PLANNING_FIRST_REFERENCE_PATH = fileURLToPath(new URL(
  "../../plugins/ezagent-spec/skills/ezagent-spec/references/planning-first.md",
  import.meta.url,
));
const CATALOG_PATH = fileURLToPath(new URL(
  "../../plugins/ezagent-spec/catalog/experts.json",
  import.meta.url,
));

describe("Work Contract v2 Skill reference", () => {
  test("ships a valid Planning-first contract with a real human gate before implementation", async () => {
    const reference = await readFile(PLANNING_FIRST_REFERENCE_PATH, "utf8");
    const match = /<!-- PLANNING_FIRST_TEMPLATE -->\s*```json\s*([\s\S]*?)\s*```/u.exec(reference);
    expect(match).not.toBeNull();
    const contract = parseWorkContractDraft(JSON.parse(match![1]!) as unknown);
    const planningSlice = contract.workSpec.slicePlan.find(({ id }) => id === "slice-planning");
    const implementationSlice = contract.workSpec.slicePlan.find(
      ({ id }) => id === "slice-implementation",
    );
    const planningCriteria = contract.workSpec.acceptanceCriteria.filter(({ id }) =>
      planningSlice?.criterionIds.includes(id)
    );

    expect(contract.workSpec.mode).toBe("standard");
    expect(contract.workSpec.deliverableInterfaces.filter(({ kind }) => kind === "document"))
      .toHaveLength(3);
    expect(planningSlice).toMatchObject({ humanCheckpoint: true, blockedBy: [] });
    expect(planningCriteria.some(({ requiredEvidenceKinds }) =>
      requiredEvidenceKinds.includes("human-approval")
    )).toBe(true);
    expect(implementationSlice?.blockedBy).toContain("slice-planning");
    expect(implementationSlice?.deliverableInterfaceIds).toContain("deliverable-implementation");
  });

  test("ships one valid Standard analysis template that Core can delegate without blockers", async () => {
    const reference = await readFile(REFERENCE_PATH, "utf8");
    const match = /<!-- STANDARD_ANALYSIS_TEMPLATE -->\s*```json\s*([\s\S]*?)\s*```/u.exec(reference);
    expect(match).not.toBeNull();
    const raw = JSON.parse(match![1]!) as unknown;
    const contract = parseWorkContractDraft(raw);
    const catalog = parseRuntimeCatalog(await readFile(CATALOG_PATH));
    const plan = proposeSpecialistPlanV2(catalog, {
      workItemId: "TASK-20260826-001",
      workSpecId: "SPEC-20260826-001",
      workSpecRevision: 0,
      planRevision: 1,
      workSpec: contract.workSpec,
      assessment: contract.specialistAssessment,
    });

    expect(contract.workSpec.mode).toBe("standard");
    expect(contract.specialistAssessment.needs).toEqual([
      expect.objectContaining({
        purpose: "analysis",
        capabilities: ["engineering-backend-architect"],
      }),
    ]);
    expect(JSON.stringify(raw)).not.toMatch(/expertId|ezagent\./u);
    expect(plan.blockers).toEqual([]);
    expect(plan.uncoveredCapabilities).toEqual([]);
    expect(plan.delegations).toHaveLength(1);
    expect(plan.delegations[0]).toMatchObject({ mode: "analysis", sliceId: "slice-tracer" });
    expect(plan.delegations[0]!.expertId)
      .toBe("ezagent.engineering.engineering-backend-architect");
    expect(reference).toMatch(/软件系统.*domains.*engineering.*不得.*自造/su);
    expect(reference).toMatch(/projectSignals.*没有.*精确.*空数组/su);
    expect(reference).toMatch(/resources.*inputPointers.*sourcePointers.*未知.*空数组/su);
    expect(reference).toMatch(/Boundary 顶层.*不得.*access/su);
    expect(reference).toMatch(/access.*只属于.*resources.*resource 元素/su);
  });

  test("maps backend implementation and independent review to precise engineering Specialists", async () => {
    const reference = await readFile(REFERENCE_PATH, "utf8");
    const match = /<!-- STANDARD_ANALYSIS_TEMPLATE -->\s*```json\s*([\s\S]*?)\s*```/u.exec(reference);
    expect(match).not.toBeNull();
    const contract = parseWorkContractDraft(JSON.parse(match![1]!) as unknown);
    const catalog = parseRuntimeCatalog(await readFile(CATALOG_PATH));
    const plan = proposeSpecialistPlanV2(catalog, {
      workItemId: "TASK-20260826-002",
      workSpecId: "SPEC-20260826-002",
      workSpecRevision: 0,
      planRevision: 1,
      workSpec: contract.workSpec,
      assessment: {
        decision: "required",
        reasons: ["后端修复需要隔离实现与独立审查"],
        needs: [
          {
            id: "need-analysis",
            sliceId: "slice-tracer",
            purpose: "analysis",
            capabilities: ["engineering-backend-architect"],
            domains: ["engineering"],
            projectSignals: [],
            isolationReason: "domain-judgment",
          },
          {
            id: "need-implementation",
            sliceId: "slice-tracer",
            purpose: "implementation",
            capabilities: ["engineering-senior-developer"],
            domains: ["engineering"],
            projectSignals: [],
            isolationReason: "context-isolation",
          },
          {
            id: "need-review",
            sliceId: "slice-tracer",
            purpose: "review",
            capabilities: ["engineering-code-reviewer"],
            domains: ["engineering"],
            projectSignals: [],
            isolationReason: "independent-review",
          },
        ],
      },
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.uncoveredCapabilities).toEqual([]);
    expect(plan.delegations).toHaveLength(3);
    expect(plan.delegations.map(({ mode, expertId }) => ({ mode, expertId })))
      .toEqual(expect.arrayContaining([
        {
          mode: "implement",
          expertId: "ezagent.engineering.engineering-senior-developer",
        },
        {
          mode: "analysis",
          expertId: "ezagent.engineering.engineering-backend-architect",
        },
        {
          mode: "review",
          expertId: "ezagent.engineering.engineering-code-reviewer",
        },
      ]));
    expect(reference).toMatch(/后端.*实施.*engineering-senior-developer/su);
    expect(reference).toMatch(/代码.*独立审查.*engineering-code-reviewer/su);
    expect(reference).toMatch(/本地项目.*resources.*空数组/su);
  });
});
