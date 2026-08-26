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
const CATALOG_PATH = fileURLToPath(new URL(
  "../../plugins/ezagent-spec/catalog/experts.json",
  import.meta.url,
));

describe("Work Contract v2 Skill reference", () => {
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
      expect.objectContaining({ purpose: "analysis", capabilities: ["architecture-design"] }),
    ]);
    expect(JSON.stringify(raw)).not.toMatch(/expertId|ezagent\./u);
    expect(plan.blockers).toEqual([]);
    expect(plan.uncoveredCapabilities).toEqual([]);
    expect(plan.delegations).toHaveLength(1);
    expect(plan.delegations[0]).toMatchObject({ mode: "analysis", sliceId: "slice-tracer" });
    expect(plan.delegations[0]!.expertId).toMatch(/^ezagent\.engineering\./u);
    expect(reference).toMatch(/软件系统.*domains.*engineering.*不得.*自造/su);
    expect(reference).toMatch(/projectSignals.*没有.*精确.*空数组/su);
    expect(reference).toMatch(/resources.*inputPointers.*sourcePointers.*未知.*空数组/su);
  });
});
