import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  batchExpertSelection,
  expandExpertSelection,
  selectExperts,
  type SelectedExpert,
  type SelectionRequest,
} from "../../src/experts/selector.js";

const translated = JSON.parse(
  readFileSync(new URL("../fixtures/experts/translated.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const chinaOriginal = JSON.parse(
  readFileSync(new URL("../fixtures/experts/china-original.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const standardRequest: SelectionRequest = {
  capabilities: ["frontend-architecture"],
  domains: ["frontend"],
  projectSignals: ["react"],
  risk: "standard",
  reviewAfter: 6,
};

function expert(
  index: number,
  capabilities: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...structuredClone(translated),
    id: `ezagent.test.expert-${index}`,
    capabilities,
    ...overrides,
  };
}

function request(overrides: Partial<SelectionRequest> = {}): SelectionRequest {
  return { ...structuredClone(standardRequest), ...overrides };
}

describe("selectExperts", () => {
  it("selects by uncovered capability with stable auditable reasons", () => {
    const result = selectExperts([translated, chinaOriginal], standardRequest);

    expect(result).toMatchObject({
      selected: [
        {
          expert: expect.objectContaining({ id: "ezagent.engineering.frontend-architect" }),
          score: 12,
          reasons: ["covers:frontend-architecture", "domain:frontend", "signal:react"],
        },
      ],
      uncoveredCapabilities: [],
      requiresPlanReview: false,
      audit: {
        schemaVersion: 1,
        requests: [standardRequest],
        catalogDeltas: [
          expect.arrayContaining([
            expect.objectContaining({
              id: "ezagent.engineering.frontend-architect",
              expertFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            }),
          ]),
        ],
        fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
  });

  it("does not truncate selections to reviewAfter or any fixed total", () => {
    const experts = Array.from({ length: 10 }, (_, index) => expert(index, [`cap-${index}`]));
    const result = selectExperts(
      experts,
      request({
        capabilities: experts.map((_, index) => `cap-${index}`),
        domains: [],
        projectSignals: [],
        reviewAfter: 6,
      }),
    );

    expect(result.selected.map((item) => item.expert.id)).toHaveLength(10);
    expect(result.uncoveredCapabilities).toEqual([]);
    expect(result.requiresPlanReview).toBe(true);
  });

  it("greedily chooses one expert that covers multiple capabilities", () => {
    const result = selectExperts(
      [expert(0, ["cap-a"]), expert(1, ["cap-b"]), expert(2, ["cap-a", "cap-b"])],
      request({ capabilities: ["cap-a", "cap-b"], domains: [], projectSignals: [] }),
    );

    expect(result.selected.map((item) => item.expert.id)).toEqual(["ezagent.test.expert-2"]);
    expect(result.selected[0]).toMatchObject({
      score: 12,
      reasons: ["covers:cap-a", "covers:cap-b"],
    });
  });

  it("prioritizes newly covered capability count over metadata bonuses", () => {
    const broadA = expert(0, ["cap-a", "cap-b"], {
      id: "ezagent.test.broad-a",
      domains: ["engineering"],
      projectSignals: [],
      preferredTasks: ["implement"],
    });
    const broadB = expert(1, ["cap-c", "cap-d"], {
      id: "ezagent.test.broad-b",
      domains: ["engineering"],
      projectSignals: [],
      preferredTasks: ["implement"],
    });
    const narrow = ["cap-a", "cap-b", "cap-c"].map((capability, index) =>
      expert(index + 2, [capability], {
        id: `ezagent.test.narrow-${index}`,
        domains: ["frontend"],
        projectSignals: ["react"],
        preferredTasks: ["review"],
      }),
    );

    const result = selectExperts(
      [...narrow, broadB, broadA],
      request({
        capabilities: ["cap-a", "cap-b", "cap-c", "cap-d"],
        domains: ["frontend"],
        projectSignals: ["react"],
        risk: "high",
      }),
    );

    expect(result.selected.map((item) => item.expert.id)).toEqual([
      "ezagent.test.broad-a",
      "ezagent.test.broad-b",
    ]);
  });

  it("breaks score ties by portable code-unit expert id order", () => {
    const zulu = expert(0, ["cap-a"], { id: "ezagent.test.zulu" });
    const alpha = expert(1, ["cap-a"], { id: "ezagent.test.alpha" });

    expect(
      selectExperts([zulu, alpha], request({ capabilities: ["cap-a"], domains: [], projectSignals: [] }))
        .selected[0]?.expert.id,
    ).toBe("ezagent.test.alpha");
  });

  it("adds and explains the high-risk review bonus", () => {
    const reviewer = expert(0, ["cap-a"], {
      id: "ezagent.test.reviewer",
      preferredTasks: ["review"],
    });
    const implementer = expert(1, ["cap-a"], {
      id: "ezagent.test.implementer",
      preferredTasks: ["implement"],
    });

    const result = selectExperts(
      [implementer, reviewer],
      request({ capabilities: ["cap-a"], domains: [], projectSignals: [], risk: "high" }),
    );

    expect(result.selected[0]).toMatchObject({
      expert: { id: "ezagent.test.reviewer" },
      score: 8,
      reasons: ["covers:cap-a", "risk:review"],
    });
  });

  it("returns stable sorted uncovered capabilities", () => {
    const result = selectExperts(
      [expert(0, ["cap-a"])],
      request({ capabilities: ["cap-z", "cap-a", "cap-m"], domains: [], projectSignals: [] }),
    );

    expect(result.uncoveredCapabilities).toEqual(["cap-m", "cap-z"]);
  });

  it("selects nobody for a zero-capability request", () => {
    expect(selectExperts([translated], request({ capabilities: [], reviewAfter: 0 }))).toMatchObject({
      selected: [],
      uncoveredCapabilities: [],
      requiresPlanReview: false,
      audit: { requests: [request({ capabilities: [], reviewAfter: 0 })] },
    });
  });

  it("uses reviewAfter only as a soft threshold, including zero", () => {
    const result = selectExperts(
      [translated],
      request({ capabilities: ["frontend-architecture"], reviewAfter: 0 }),
    );

    expect(result.selected).toHaveLength(1);
    expect(result.requiresPlanReview).toBe(true);
  });

  it("rejects duplicate expert ids and duplicate canonical request tokens", () => {
    expect(() => selectExperts([translated, structuredClone(translated)], standardRequest)).toThrow(
      /duplicate expert id/i,
    );
    expect(() =>
      selectExperts([translated], request({ capabilities: ["frontend-architecture", " frontend-architecture "] })),
    ).toThrow(/capabilities.*duplicate/i);
  });

  it.each([
    ["unknown risk", request({ risk: "critical" as SelectionRequest["risk"] })],
    ["NaN reviewAfter", request({ reviewAfter: Number.NaN })],
    ["unsafe reviewAfter", request({ reviewAfter: Number.MAX_SAFE_INTEGER + 1 })],
    ["negative reviewAfter", request({ reviewAfter: -1 })],
    ["illegal token", request({ capabilities: ["Frontend Architecture"] })],
  ])("rejects %s", (_label, invalidRequest) => {
    expect(() => selectExperts([translated], invalidRequest)).toThrow();
  });

  it("rejects request accessors without invoking them", () => {
    let calls = 0;
    const invalidRequest = request();
    Object.defineProperty(invalidRequest, "risk", {
      enumerable: true,
      get() {
        calls += 1;
        return "standard";
      },
    });

    expect(() => selectExperts([translated], invalidRequest)).toThrow(/risk.*accessor/i);
    expect(calls).toBe(0);
  });

  it("rejects catalog and request Proxies without invoking their traps", () => {
    let catalogCalls = 0;
    const catalogProxy = new Proxy([translated], {
      get() {
        catalogCalls += 1;
        throw new Error("catalog trap must not run");
      },
      getOwnPropertyDescriptor() {
        catalogCalls += 1;
        throw new Error("catalog trap must not run");
      },
      ownKeys() {
        catalogCalls += 1;
        throw new Error("catalog trap must not run");
      },
    });
    let requestCalls = 0;
    const requestProxy = new Proxy(request(), {
      get() {
        requestCalls += 1;
        throw new Error("request trap must not run");
      },
      getPrototypeOf() {
        requestCalls += 1;
        throw new Error("request trap must not run");
      },
    });

    expect(() => selectExperts(catalogProxy, standardRequest)).toThrow(/catalog.*Proxy/i);
    expect(catalogCalls).toBe(0);
    expect(() => selectExperts([translated], requestProxy)).toThrow(/request.*Proxy/i);
    expect(requestCalls).toBe(0);
  });

  it("rejects sparse, extra-key, and oversized input arrays", () => {
    const sparse = [translated, , chinaOriginal];
    const extra = [translated];
    Object.defineProperty(extra, "metadata", { value: true, enumerable: true });
    const oversized = Array.from({ length: 513 }, () => "cap-a");

    expect(() => selectExperts(sparse, standardRequest)).toThrow(/catalog.*dense/i);
    expect(() => selectExperts(extra, standardRequest)).toThrow(/catalog.*unsupported/i);
    expect(() =>
      selectExperts([translated], request({ capabilities: oversized })),
    ).toThrow(/capabilities.*more than 512/i);
  });

  it("fails raw length bounds before trimming huge tokens", () => {
    expect(() =>
      selectExperts(
        [translated],
        request({ capabilities: [`${" ".repeat(1_000_000)}frontend-architecture`] }),
      ),
    ).toThrow(/raw length/i);
  });

  it("returns snapshots that do not change when inputs mutate", () => {
    const mutableExpert = structuredClone(translated) as Record<string, unknown>;
    const mutableRequest = request();
    const result = selectExperts([mutableExpert], mutableRequest);

    mutableExpert.id = "ezagent.test.mutated";
    mutableRequest.capabilities[0] = "mutated";

    expect(result.selected[0]?.expert.id).toBe("ezagent.engineering.frontend-architect");
    expect(result.selected[0]?.reasons).toEqual([
      "covers:frontend-architecture",
      "domain:frontend",
      "signal:react",
    ]);
    expect(result.audit.requests[0]?.capabilities).toEqual(["frontend-architecture"]);
  });

  it("handles a large bounded catalog deterministically", () => {
    const capabilities = Array.from({ length: 256 }, (_, index) => `scale-cap-${index}`);
    const experts = Array.from({ length: 1_024 }, (_, index) =>
      expert(index, [capabilities[index % capabilities.length]!], {
        id: `ezagent.scale.expert-${index}`,
        domains: ["engineering"],
        projectSignals: [],
      }),
    );

    const first = selectExperts(
      experts,
      request({ capabilities, domains: [], projectSignals: [] }),
    );
    const second = selectExperts(
      [...experts].reverse(),
      request({ capabilities, domains: [], projectSignals: [] }),
    );

    expect(first.selected).toHaveLength(256);
    expect(second.selected.map((item) => item.expert.id)).toEqual(
      first.selected.map((item) => item.expert.id),
    );
  });
});

describe("expandExpertSelection", () => {
  it("adds only experts needed for old uncovered and new capabilities", () => {
    const initialCatalog = [expert(0, ["cap-a"])];
    const expandedCatalog = [
      ...initialCatalog,
      expert(1, ["cap-b"]),
      expert(2, ["cap-c"]),
      expert(3, ["cap-unused"]),
    ];
    const initial = selectExperts(
      initialCatalog,
      request({ capabilities: ["cap-a", "cap-b"], domains: [], projectSignals: [] }),
    );
    const expanded = expandExpertSelection(
      initial,
      expandedCatalog,
      request({ capabilities: ["cap-c"], domains: [], projectSignals: [], reviewAfter: 2 }),
    );

    expect(expanded.selected.map((item) => item.expert.id)).toEqual([
      "ezagent.test.expert-0",
      "ezagent.test.expert-1",
      "ezagent.test.expert-2",
    ]);
    expect(expanded.uncoveredCapabilities).toEqual([]);
    expect(expanded.requiresPlanReview).toBe(true);
    expect(expanded.audit.requests).toHaveLength(2);
    expect(expanded.audit.catalogDeltas[0]?.map((entry) => entry.id)).toEqual([
      "ezagent.test.expert-0",
    ]);
    expect(expanded.audit.catalogDeltas[1]?.map((entry) => entry.id)).toEqual([
      "ezagent.test.expert-1",
      "ezagent.test.expert-2",
      "ezagent.test.expert-3",
    ]);
  });

  it("preserves current order, scores, and reasons and does not repeat ids", () => {
    const catalog = [expert(1, ["cap-b"]), expert(0, ["cap-a"]), expert(2, ["cap-c"])];
    const initial = selectExperts(
      catalog,
      request({ capabilities: ["cap-b", "cap-a"], domains: [], projectSignals: [] }),
    );
    const before = structuredClone(initial.selected);

    const expanded = expandExpertSelection(
      initial,
      catalog,
      request({ capabilities: ["cap-c"], domains: [], projectSignals: [] }),
    );

    expect(expanded.selected.slice(0, before.length)).toEqual(before);
    expect(new Set(expanded.selected.map((item) => item.expert.id)).size).toBe(
      expanded.selected.length,
    );
  });

  it("keeps capabilities uncovered when no expert can cover them", () => {
    const initial = selectExperts([], request({ capabilities: ["cap-old"], domains: [], projectSignals: [] }));
    const expanded = expandExpertSelection(
      initial,
      [expert(0, ["cap-other"])],
      request({ capabilities: ["cap-new"], domains: [], projectSignals: [] }),
    );

    expect(expanded.selected).toEqual([]);
    expect(expanded.uncoveredCapabilities).toEqual(["cap-new", "cap-old"]);
  });

  it("rejects duplicate catalog ids and a mutated catalog copy of a current expert", () => {
    const initial = selectExperts(
      [expert(0, ["cap-a"])],
      request({ capabilities: ["cap-a"], domains: [], projectSignals: [] }),
    );
    const mutated = expert(0, ["cap-mutated"]);

    expect(() =>
      expandExpertSelection(
        initial,
        [expert(1, ["cap-b"]), expert(1, ["cap-b"])],
        request({ capabilities: ["cap-b"], domains: [], projectSignals: [] }),
      ),
    ).toThrow(/duplicate expert id/i);
    expect(() =>
      expandExpertSelection(
        initial,
        [mutated],
        request({ capabilities: ["cap-b"], domains: [], projectSignals: [] }),
      ),
    ).toThrow(/changed.*expert/i);
  });

  it("rejects a current expert that is absent from the reviewed catalog", () => {
    const initial = selectExperts(
      [expert(0, ["cap-a"])],
      request({ capabilities: ["cap-a"], domains: [], projectSignals: [] }),
    );

    expect(() =>
      expandExpertSelection(
        initial,
        [expert(1, ["cap-b"])],
        request({ capabilities: ["cap-b"], domains: [], projectSignals: [] }),
      ),
    ).toThrow(/absent from.*catalog/i);
  });

  it("rejects mutation or deletion of a historically reviewed unselected expert", () => {
    const catalog = [
      expert(0, ["cap-a"], { domains: ["engineering"] }),
      expert(1, ["cap-b"], { domains: ["frontend"] }),
    ];
    const initial = selectExperts(
      catalog,
      request({ capabilities: ["cap-a"], domains: ["frontend"], projectSignals: [] }),
    );
    const changedCatalog = [
      expert(0, ["cap-a"], { domains: ["engineering"] }),
      expert(1, ["cap-a", "cap-b"], { domains: ["frontend"] }),
    ];

    expect(() =>
      expandExpertSelection(
        initial,
        changedCatalog,
        request({ capabilities: ["cap-c"], domains: [], projectSignals: [] }),
      ),
    ).toThrow(/replay|catalog.*changed|fingerprint/i);

    expect(() =>
      expandExpertSelection(
        initial,
        [catalog[0]],
        request({ capabilities: ["cap-c"], domains: [], projectSignals: [] }),
      ),
    ).toThrow(/absent from.*catalog|deleted/i);
  });

  it.each(["score", "reasons", "uncovered", "request", "fingerprint"] as const)(
    "rejects replay-inconsistent current %s",
    (mutation) => {
      const catalog = [expert(0, ["cap-a"]), expert(1, ["cap-b"])];
      const initial = selectExperts(
        catalog,
        request({ capabilities: ["cap-a", "cap-missing"], domains: [], projectSignals: [] }),
      );
      const forged = structuredClone(initial);
      if (mutation === "score") forged.selected[0]!.score += 2;
      if (mutation === "reasons") forged.selected[0]!.reasons.push("risk:review");
      if (mutation === "uncovered") forged.uncoveredCapabilities = ["cap-forged"];
      if (mutation === "request") forged.audit.requests[0]!.capabilities = ["cap-b"];
      if (mutation === "fingerprint") forged.audit.fingerprint = `sha256:${"0".repeat(64)}`;

      expect(() =>
        expandExpertSelection(
          forged,
          catalog,
          request({ capabilities: ["cap-b"], domains: [], projectSignals: [] }),
        ),
      ).toThrow(/audit|fingerprint|replay|score|reason/i);
    },
  );

  it("strictly validates current results without invoking accessors", () => {
    const initial = selectExperts(
      [expert(0, ["cap-a"])],
      request({ capabilities: ["cap-a"], domains: [], projectSignals: [] }),
    );
    let calls = 0;
    Object.defineProperty(initial.selected[0], "score", {
      enumerable: true,
      get() {
        calls += 1;
        return 6;
      },
    });

    expect(() =>
      expandExpertSelection(initial, [expert(0, ["cap-a"])], request({ capabilities: [] })),
    ).toThrow(
      /score.*accessor/i,
    );
    expect(calls).toBe(0);
  });

  it("snapshots current selection instead of returning caller-owned references", () => {
    const initial = selectExperts(
      [expert(0, ["cap-a"])],
      request({ capabilities: ["cap-a"], domains: [], projectSignals: [] }),
    );
    const expanded = expandExpertSelection(
      initial,
      [expert(0, ["cap-a"])],
      request({ capabilities: [] }),
    );

    initial.selected[0]!.reasons[0] = "covers:mutated";
    expect(expanded.selected[0]?.reasons).toEqual(["covers:cap-a"]);
  });

  it("accumulates more than one public request worth of uncovered capabilities", () => {
    const round = (roundIndex: number) =>
      Array.from({ length: 512 }, (_, index) => `round-${roundIndex}-cap-${index}`);
    let current = selectExperts(
      [],
      request({ capabilities: round(0), domains: [], projectSignals: [] }),
    );
    current = expandExpertSelection(
      current,
      [],
      request({ capabilities: round(1), domains: [], projectSignals: [] }),
    );
    current = expandExpertSelection(
      current,
      [],
      request({ capabilities: round(2), domains: [], projectSignals: [] }),
    );

    expect(current.uncoveredCapabilities).toHaveLength(1_536);
    expect(current.audit.requests).toHaveLength(3);
  });

  it("rejects only before cumulative uncovered capabilities would exceed the budget", () => {
    const round = (roundIndex: number) =>
      Array.from({ length: 512 }, (_, index) => `budget-${roundIndex}-cap-${index}`);
    let current = selectExperts(
      [],
      request({ capabilities: round(0), domains: [], projectSignals: [] }),
    );
    for (let roundIndex = 1; roundIndex < 32; roundIndex += 1) {
      current = expandExpertSelection(
        current,
        [],
        request({ capabilities: round(roundIndex), domains: [], projectSignals: [] }),
      );
    }
    const before = structuredClone(current);

    expect(current.uncoveredCapabilities).toHaveLength(16_384);
    expect(() =>
      expandExpertSelection(
        current,
        [],
        request({ capabilities: round(32), domains: [], projectSignals: [] }),
      ),
    ).toThrow(/cumulative uncovered.*16384/i);
    expect(current).toEqual(before);
  });

  it("rejects before creating a sixty-fifth history stage and leaves the prior result readable", () => {
    const emptyRequest = request({ capabilities: [], domains: [], projectSignals: [] });
    let current = selectExperts([], emptyRequest);
    for (let index = 1; index < 64; index += 1) {
      current = expandExpertSelection(current, [], emptyRequest);
    }
    const before = structuredClone(current);

    expect(current.audit.requests).toHaveLength(64);
    expect(() => expandExpertSelection(current, [], emptyRequest)).toThrow(/history.*64/i);
    expect(current).toEqual(before);
  });

  it("rejects aggregate full-request history before retaining unbounded token data", () => {
    const fullRequest = request({
      capabilities: Array.from({ length: 512 }, (_, index) => `full-cap-${index}`),
      domains: Array.from({ length: 512 }, (_, index) => `full-domain-${index}`),
      projectSignals: Array.from({ length: 512 }, (_, index) => `full-signal-${index}`),
    });
    let current = selectExperts([], fullRequest);
    let accepted = 1;
    while (accepted < 64) {
      try {
        current = expandExpertSelection(current, [], fullRequest);
        accepted += 1;
      } catch (error) {
        expect(error).toMatchObject({ message: expect.stringMatching(/history.*(token|byte|UTF-16)/i) });
        break;
      }
    }

    expect(accepted).toBeLessThan(64);
    expect(current.audit.requests).toHaveLength(accepted);
  });
});

describe("batchExpertSelection", () => {
  function selections(length: number): SelectedExpert[] {
    return Array.from({ length }, (_, index) => ({
      expert: {
        ...structuredClone(translated),
        id: `ezagent.test.expert-${index}`,
      } as never,
      score: 6,
      reasons: [`covers:cap-${index}`],
    }));
  }

  it("batches every selected expert exactly once in original order", () => {
    const selected = selections(8);
    const batches = batchExpertSelection(selected, 3);

    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 2]);
    expect(batches.flat().map((item) => item.expert.id)).toEqual(
      selected.map((item) => item.expert.id),
    );
    expect(batches.flat()[0]).toBe(selected[0]);
  });

  it("handles empty selection and limits larger than the selection", () => {
    expect(batchExpertSelection([], 3)).toEqual([]);
    expect(batchExpertSelection(selections(2), 10)).toHaveLength(1);
  });

  it.each([0, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid concurrency limit %s",
    (limit) => {
      expect(() => batchExpertSelection([], limit)).toThrow(/positive safe integer/i);
    },
  );

  it("is a typed scheduling primitive and does not reinterpret selected payloads", () => {
    const selected = selections(4_097);
    selected[0]!.score = Number.NaN;
    selected[0]!.reasons = ["caller-owned-audit-record"];

    const batches = batchExpertSelection(selected, 4_097);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(4_097);
    expect(batches[0]?.[0]).toBe(selected[0]);
  });
});
