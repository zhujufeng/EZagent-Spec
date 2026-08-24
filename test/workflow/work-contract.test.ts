import { describe, expect, test } from "vitest";

import { parseWorkContractDraft } from "../../src/workflow/work-contract.js";
import { genericWorkContractDraft } from "../fixtures/work-contract-fixture.js";

describe("Work Contract v2", () => {
  test("accepts one domain-neutral tracer slice without a role enum or expert team", () => {
    const contract = parseWorkContractDraft(genericWorkContractDraft);

    expect(contract.workSpec.mode).toBe("brief");
    expect(contract.workSpec.slicePlan[0]?.id).toBe("slice-tracer");
    expect(contract).not.toHaveProperty("role");
    expect(contract).not.toHaveProperty("expertTeam");
    expect(Object.isFrozen(contract.workSpec.slicePlan)).toBe(true);
  });
});
