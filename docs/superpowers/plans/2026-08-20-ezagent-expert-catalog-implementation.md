# EZagent Offline Expert Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible, licensed, offline Chinese expert snapshot and an adaptive selector that activates only the expertise required by the current project and task.

**Architecture:** Treat upstream repositories as release-time inputs, never runtime dependencies. Resolve reviewed source refs into immutable full SHAs, normalize Markdown into a strict internal schema, verify provenance and hashes, then select experts with deterministic coverage scoring plus auditable dynamic expansion.

**Tech Stack:** TypeScript, Zod, YAML, Node crypto/filesystem APIs, Vitest, Git used only by the explicit release-time source-lock step.

---

## File map

- `catalog/sources.yaml`: reviewed repository/ref candidates; not used at runtime.
- `catalog/sources.lock.json`: generated immutable source SHAs and licenses.
- `catalog/taxonomy.yaml`: division-to-domain and capability mappings.
- `catalog/normalized/experts.json`: generated offline snapshot.
- `src/experts/expert.ts`: normalized expert schema.
- `src/experts/source-lock.ts`: local checkout verification and immutable lock creation.
- `src/experts/importer.ts`: source-file normalization.
- `src/experts/catalog.ts`: snapshot loading and full validation.
- `src/experts/selector.ts`: coverage-based initial selection and expansion.
- `src/experts/active.ts`: revisioned project-level active-expert state.
- `scripts/lock-catalog-sources.ts`: release-time source lock command.
- `scripts/import-experts.ts`: release-time normalization command.
- `scripts/verify-catalog.ts`: schema, count, provenance, hash, and notice checks.
- `THIRD_PARTY_NOTICES.md`: product-level attribution.
- `licenses/*.txt`: verbatim MIT license texts.

### Task 1: Define the normalized expert contract

**Files:**
- Create: `src/experts/expert.ts`
- Create: `test/experts/expert.test.ts`
- Create: `test/fixtures/experts/translated.json`
- Create: `test/fixtures/experts/china-original.json`

- [ ] **Step 1: Write a failing schema test**

```ts
// test/experts/expert.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseExpert } from "../../src/experts/expert.js";

describe("normalized expert schema", () => {
  it.each(["translated", "china-original"])("accepts the %s fixture", async (name) => {
    const fixture = JSON.parse(await readFile(new URL(`../fixtures/experts/${name}.json`, import.meta.url), "utf8"));
    expect(parseExpert(fixture).id).toMatch(/^ezagent\./);
  });

  it("requires a full source commit SHA", () => {
    expect(() => parseExpert({ id: "ezagent.bad" })).toThrow();
  });
});
```

- [ ] **Step 2: Add complete representative fixtures**

```json
{
  "id": "ezagent.engineering.frontend-architect",
  "nameZh": "前端架构师",
  "summaryZh": "负责前端边界、状态和可维护性设计。",
  "instructionsZh": "基于项目证据分析前端结构，只在任务范围内给出结论。",
  "capabilities": ["frontend-architecture", "state-design"],
  "domains": ["engineering", "frontend"],
  "projectSignals": ["react", "vue", "web-ui"],
  "activationConditions": ["跨组件行为变化"],
  "exclusionConditions": ["纯后端数据迁移"],
  "preferredTasks": ["design", "review"],
  "qualityGates": ["引用实际文件", "覆盖错误状态"],
  "origin": "upstream_translation",
  "source": {
    "repository": "https://github.com/jnMetaCode/agency-agents-zh",
    "path": "engineering/frontend-architect.md",
    "commit": "1111111111111111111111111111111111111111",
    "license": "MIT"
  },
  "upstreamSource": {
    "repository": "https://github.com/msitarzewski/agency-agents",
    "path": "engineering/frontend-architect.md",
    "commit": "2222222222222222222222222222222222222222",
    "license": "MIT"
  },
  "contentHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

```json
{
  "id": "ezagent.china.private-domain-product-specialist",
  "nameZh": "中国私域产品专家",
  "summaryZh": "负责中国私域产品场景和用户路径分析。",
  "instructionsZh": "结合项目目标分析私域产品路径，不替代工程实现专家。",
  "capabilities": ["china-private-domain", "product-design"],
  "domains": ["product", "china-market"],
  "projectSignals": ["wechat", "mini-program"],
  "activationConditions": ["任务涉及中国私域产品场景"],
  "exclusionConditions": ["纯底层工程优化"],
  "preferredTasks": ["clarify", "design", "review"],
  "qualityGates": ["明确用户路径", "不扩大任务范围"],
  "origin": "china_original",
  "source": {
    "repository": "https://github.com/jnMetaCode/agency-agents-zh",
    "path": "china/private-domain-product-specialist.md",
    "commit": "3333333333333333333333333333333333333333",
    "license": "MIT"
  },
  "contentHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

- [ ] **Step 3: Run the test and observe the missing module failure**

Run: `npm test -- test/experts/expert.test.ts`

Expected: FAIL because `src/experts/expert.ts` does not exist.

- [ ] **Step 4: Implement the complete schema**

```ts
// src/experts/expert.ts
import { z } from "zod";

const sourceRefSchema = z.object({
  repository: z.string().url(),
  path: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  license: z.literal("MIT"),
});

export const expertSchema = z.object({
  id: z.string().regex(/^ezagent\.[a-z0-9.-]+$/),
  nameZh: z.string().min(1),
  summaryZh: z.string().min(1),
  instructionsZh: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  domains: z.array(z.string().min(1)).min(1),
  projectSignals: z.array(z.string().min(1)),
  activationConditions: z.array(z.string().min(1)).min(1),
  exclusionConditions: z.array(z.string().min(1)),
  preferredTasks: z.array(z.enum(["clarify", "design", "implement", "verify", "review"])).min(1),
  qualityGates: z.array(z.string().min(1)).min(1),
  origin: z.enum(["upstream_translation", "china_original"]),
  source: sourceRefSchema,
  upstreamSource: sourceRefSchema.optional(),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).superRefine((expert, context) => {
  if (expert.origin === "upstream_translation" && !expert.upstreamSource) {
    context.addIssue({ code: "custom", message: "translated experts require upstreamSource" });
  }
  if (expert.origin === "china_original" && expert.upstreamSource) {
    context.addIssue({ code: "custom", message: "China-original experts cannot declare upstreamSource" });
  }
});

export type Expert = z.infer<typeof expertSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export const parseExpert = (value: unknown): Expert => expertSchema.parse(value);
```

- [ ] **Step 5: Verify contract and commit**

Run: `npm test -- test/experts/expert.test.ts && npm run check`

Expected: PASS with 3 tests.

```bash
git add src/experts/expert.ts test/experts test/fixtures/experts
git commit -m "feat: define normalized expert schema"
```

### Task 2: Lock release-time source checkouts to immutable SHAs

**Files:**
- Create: `catalog/sources.yaml`
- Create: `src/experts/source-lock.ts`
- Create: `scripts/lock-catalog-sources.ts`
- Test: `test/experts/source-lock.test.ts`

- [ ] **Step 1: Add reviewed source candidates**

```yaml
# catalog/sources.yaml
schemaVersion: 1
sources:
  - id: agency-agents
    repository: https://github.com/msitarzewski/agency-agents
    ref: 3f78a30
    checkout: vendor-sources/agency-agents
    license: MIT
  - id: agency-agents-zh
    repository: https://github.com/jnMetaCode/agency-agents-zh
    ref: main
    checkout: vendor-sources/agency-agents-zh
    license: MIT
```

`vendor-sources/` must be added to `.gitignore`; source checkouts are release inputs, not vendored product code.

- [ ] **Step 2: Write a failing local-checkout lock test**

```ts
// test/experts/source-lock.test.ts
import { describe, expect, it } from "vitest";
import { createSourceLock } from "../../src/experts/source-lock.js";

describe("createSourceLock", () => {
  it("rejects a non-full commit from the checkout resolver", async () => {
    await expect(createSourceLock([{ id: "x", repository: "https://example.com/x", ref: "main", checkout: "x", license: "MIT" }], async () => "abc"))
      .rejects.toThrow("40-character");
  });
});
```

- [ ] **Step 3: Implement source lock creation**

```ts
// src/experts/source-lock.ts
export interface SourceCandidate { id: string; repository: string; ref: string; checkout: string; license: "MIT" }
export interface LockedSource extends Omit<SourceCandidate, "ref" | "checkout"> { commit: string }

export async function createSourceLock(
  candidates: SourceCandidate[],
  resolveCommit: (checkout: string) => Promise<string>,
): Promise<{ schemaVersion: 1; sources: LockedSource[] }> {
  const sources: LockedSource[] = [];
  for (const candidate of candidates) {
    const commit = (await resolveCommit(candidate.checkout)).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${candidate.id} did not resolve to a 40-character commit SHA`);
    sources.push({ id: candidate.id, repository: candidate.repository, license: candidate.license, commit });
  }
  return { schemaVersion: 1, sources };
}
```

- [ ] **Step 4: Add an explicit release-only lock command**

```ts
// scripts/lock-catalog-sources.ts
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { parse } from "yaml";
import { createSourceLock, type SourceCandidate } from "../src/experts/source-lock.js";

const execFileAsync = promisify(execFile);
const config = parse(await readFile("catalog/sources.yaml", "utf8")) as { sources: SourceCandidate[] };
const lock = await createSourceLock(config.sources, async (checkout) => {
  const { stdout } = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"]);
  return stdout;
});
await writeFile("catalog/sources.lock.json", `${JSON.stringify(lock, null, 2)}\n`, "utf8");
process.stdout.write(`locked ${lock.sources.length} catalog sources\n`);
```

Add scripts to `package.json`:

```json
{
  "catalog:lock": "tsx scripts/lock-catalog-sources.ts",
  "catalog:import": "tsx scripts/import-experts.ts",
  "catalog:verify": "tsx scripts/verify-catalog.ts"
}
```

- [ ] **Step 5: Verify lock behavior and commit without fetching**

Run: `npm test -- test/experts/source-lock.test.ts && npm run check`

Expected: PASS. Do not clone or contact either source repository in this step.

```bash
git add .gitignore package.json catalog/sources.yaml src/experts/source-lock.ts scripts/lock-catalog-sources.ts test/experts/source-lock.test.ts
git commit -m "feat: lock expert sources by commit"
```

### Task 3: Normalize source files with complete per-expert metadata

**Files:**
- Create: `catalog/taxonomy.yaml`
- Create: `src/experts/importer.ts`
- Create: `scripts/import-experts.ts`
- Test: `test/experts/importer.test.ts`
- Test fixtures: `test/fixtures/source-repos/**`

- [ ] **Step 1: Add an explicit taxonomy and one complete expert mapping**

```yaml
# catalog/taxonomy.yaml
schemaVersion: 1
divisions:
  engineering:
    defaultDomains: [engineering]
  design:
    defaultDomains: [design]
  testing:
    defaultDomains: [quality]
experts:
  engineering/frontend-architect.md:
    domains: [engineering, frontend]
    capabilities: [frontend-architecture, state-design]
    projectSignals: [react, vue, web-ui]
    activationConditions: [跨组件行为变化]
    exclusionConditions: [纯后端数据迁移]
    preferredTasks: [design, review]
    qualityGates: [引用实际文件, 覆盖错误状态]
```

Every source division and every Chinese expert source path discovered by the full import must have an entry before the importer succeeds. The importer prints missing division names and missing expert paths separately and exits non-zero; it must never give every expert in a division the same generic capabilities. This curated file is original EZagent metadata, not copied orchestration content.

- [ ] **Step 2: Write a failing normalization test**

```ts
// test/experts/importer.test.ts
import { describe, expect, it } from "vitest";
import { normalizeExpertFile } from "../../src/experts/importer.js";

describe("normalizeExpertFile", () => {
  it("produces stable provenance and a content hash", () => {
    const expert = normalizeExpertFile({
      division: "engineering",
      relativePath: "engineering/frontend-architect.md",
      markdown: "---\nname: 前端架构师\ndescription: 负责前端结构。\n---\n# 前端架构师\n\n分析组件边界。",
      source: { repository: "https://github.com/jnMetaCode/agency-agents-zh", path: "engineering/frontend-architect.md", commit: "1".repeat(40), license: "MIT" },
      upstreamSource: { repository: "https://github.com/msitarzewski/agency-agents", path: "engineering/frontend-architect.md", commit: "2".repeat(40), license: "MIT" },
      taxonomy: {
        domains: ["engineering", "frontend"], capabilities: ["frontend-architecture"], projectSignals: ["react"],
        activationConditions: ["跨组件行为变化"], exclusionConditions: ["纯后端数据迁移"], preferredTasks: ["design", "review"],
        qualityGates: ["引用实际文件", "覆盖错误状态"],
      },
    });
    expect(expert).toMatchObject({ id: "ezagent.engineering.frontend-architect", origin: "upstream_translation" });
    expect(expert.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 3: Implement Markdown normalization**

```ts
// src/experts/importer.ts
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { parseExpert, type Expert, type SourceRef } from "./expert.js";

interface NormalizeInput {
  division: string;
  relativePath: string;
  markdown: string;
  source: SourceRef;
  upstreamSource?: SourceRef;
  taxonomy: {
    domains: string[];
    capabilities: string[];
    projectSignals: string[];
    activationConditions: string[];
    exclusionConditions: string[];
    preferredTasks: Array<"clarify" | "design" | "implement" | "verify" | "review">;
    qualityGates: string[];
  };
}

function splitFrontmatter(markdown: string): { metadata: Record<string, unknown>; body: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("expert file requires YAML frontmatter");
  return { metadata: parseYaml(match[1]!) as Record<string, unknown>, body: match[2]!.trim() };
}

export function normalizeExpertFile(input: NormalizeInput): Expert {
  const { metadata, body } = splitFrontmatter(input.markdown.replaceAll("\r\n", "\n"));
  const slug = input.relativePath.split("/").at(-1)!.replace(/\.md$/, "");
  const nameZh = String(metadata.name ?? "").trim();
  const summaryZh = String(metadata.description ?? "").trim();
  const contentHash = `sha256:${createHash("sha256").update(input.markdown.replaceAll("\r\n", "\n")).digest("hex")}`;
  return parseExpert({
    id: `ezagent.${input.division}.${slug}`,
    nameZh,
    summaryZh,
    instructionsZh: body,
    capabilities: input.taxonomy.capabilities,
    domains: input.taxonomy.domains,
    projectSignals: input.taxonomy.projectSignals,
    activationConditions: input.taxonomy.activationConditions,
    exclusionConditions: input.taxonomy.exclusionConditions,
    preferredTasks: input.taxonomy.preferredTasks,
    qualityGates: input.taxonomy.qualityGates,
    origin: input.upstreamSource ? "upstream_translation" : "china_original",
    source: input.source,
    ...(input.upstreamSource ? { upstreamSource: input.upstreamSource } : {}),
    contentHash,
  });
}
```

- [ ] **Step 4: Implement the import command around local checkouts**

`scripts/import-experts.ts` must perform these exact operations:

```ts
const locked = await loadAndValidateSourceLock("catalog/sources.lock.json");
const english = await indexMarkdownFiles("vendor-sources/agency-agents", locked.sourcesById["agency-agents"]);
const chinese = await indexMarkdownFiles("vendor-sources/agency-agents-zh", locked.sourcesById["agency-agents-zh"]);
const experts = chinese.map((file) => normalizeExpertFile({
  ...file,
  upstreamSource: english.get(file.relativePath)?.source,
  taxonomy: taxonomyFor(file.division, file.relativePath),
}));
await writeNormalizedCatalog("catalog/normalized/experts.json", experts);
```

Define the referenced helpers in the same file or focused modules. They must sort paths and output records by `id`, reject duplicate IDs, reject empty Markdown, reject unknown divisions, reject missing/extra per-expert metadata keys, and use only the two local checkout directories. They must not execute Git or make network requests.

- [ ] **Step 5: Verify deterministic fixture import and commit**

Run: `npm test -- test/experts/importer.test.ts && npm run check`

Expected: PASS; running the fixture importer twice produces byte-identical JSON.

```bash
git add catalog/taxonomy.yaml src/experts/importer.ts scripts/import-experts.ts test/experts/importer.test.ts test/fixtures/source-repos
git commit -m "feat: normalize Chinese expert sources"
```

### Task 4: Add catalog loading, verification, and license boundaries

**Files:**
- Create: `src/experts/catalog.ts`
- Create: `scripts/verify-catalog.ts`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `licenses/agency-agents-MIT.txt`
- Create: `licenses/agency-agents-zh-MIT.txt`
- Test: `test/experts/catalog.test.ts`

- [ ] **Step 1: Write failing validation tests**

```ts
// test/experts/catalog.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateCatalog } from "../../src/experts/catalog.js";

describe("validateCatalog", () => {
  it("rejects duplicate IDs and missing notices", async () => {
    const duplicate = JSON.parse(readFileSync(new URL("../fixtures/experts/translated.json", import.meta.url), "utf8"));
    expect(() => validateCatalog([duplicate, duplicate], new Set())).toThrow("duplicate expert id");
    expect(() => validateCatalog([duplicate], new Set())).toThrow("missing license notice");
  });
});
```

- [ ] **Step 2: Implement catalog validation**

```ts
// src/experts/catalog.ts
import { parseExpert, type Expert } from "./expert.js";

export function validateCatalog(values: unknown[], availableLicenseIds: Set<string>): Expert[] {
  const experts = values.map(parseExpert);
  const seen = new Set<string>();
  for (const expert of experts) {
    if (seen.has(expert.id)) throw new Error(`duplicate expert id: ${expert.id}`);
    seen.add(expert.id);
    if (!availableLicenseIds.has(expert.source.repository)) throw new Error(`missing license notice: ${expert.source.repository}`);
  }
  return experts.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 3: Add attribution documents**

Use this notice content and copy the two MIT license files verbatim from the reviewed checkouts:

The copyright lines below are a factual correction against the reviewed upstream LICENSE bytes; all other notice wording remains unchanged.

```markdown
# Third-Party Notices

EZagent Spec includes normalized expert definitions derived from the following MIT-licensed projects.

## Agency Agents

- Repository: https://github.com/msitarzewski/agency-agents
- Copyright: Copyright (c) 2025 AgentLand Contributors
- Included material: source taxonomy and English expert definitions used to trace translated records
- License: `licenses/agency-agents-MIT.txt`

## Agency Agents 中文项目

- Repository: https://github.com/jnMetaCode/agency-agents-zh
- Copyright: Copyright (c) 2025 Michael Sitarzewski (original English version); Copyright (c) 2026 jnMetaCode (Chinese translation and localization)
- Included material: Chinese expert translations and China-original expert definitions
- License: `licenses/agency-agents-zh-MIT.txt`

No orchestration scripts, service integrations, advertisements, or runtime update code from either project are included.
```

- [ ] **Step 4: Add the verification command**

`scripts/verify-catalog.ts` must load the generated snapshot, verify all schemas, duplicate IDs, full SHAs, source paths, content hashes, both notices, and these origin rules:

```ts
if (expert.origin === "upstream_translation" && !expert.upstreamSource) fail(expert.id);
if (expert.origin === "china_original" && expert.upstreamSource) fail(expert.id);
if (createHash("sha256").update(sourceMarkdown).digest("hex") !== expert.contentHash.slice(7)) fail(expert.id);
```

Expected success output starts with `catalog valid:` and ends with `experts, 0 provenance errors`; the integer between them is computed from the snapshot.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/experts/catalog.test.ts && npm run check`

Expected: PASS. `npm run catalog:verify` is not run until the real source snapshot exists.

```bash
git add src/experts/catalog.ts scripts/verify-catalog.ts THIRD_PARTY_NOTICES.md licenses test/experts/catalog.test.ts
git commit -m "feat: verify expert provenance and licenses"
```

### Task 5: Implement adaptive selection without a total cap

**Files:**
- Create: `src/experts/selector.ts`
- Test: `test/experts/selector.test.ts`

- [ ] **Step 1: Write failing selection tests**

```ts
// test/experts/selector.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { batchExpertSelection, selectExperts } from "../../src/experts/selector.js";

const translated = JSON.parse(readFileSync(new URL("../fixtures/experts/translated.json", import.meta.url), "utf8"));
const chinaOriginal = JSON.parse(readFileSync(new URL("../fixtures/experts/china-original.json", import.meta.url), "utf8"));

describe("selectExperts", () => {
  it("selects by uncovered capability and records reasons", () => {
    const result = selectExperts([translated, chinaOriginal], {
      capabilities: ["frontend-architecture"], domains: ["frontend"], projectSignals: ["react"], risk: "standard", reviewAfter: 6,
    });
    expect(result.selected[0]?.reasons.length).toBeGreaterThan(0);
  });

  it("does not truncate selections to a fixed total", () => {
    const experts = Array.from({ length: 8 }, (_, index) => ({ ...translated, id: `ezagent.test.expert-${index}`, capabilities: [`cap-${index}`] }));
    const result = selectExperts(experts, {
      capabilities: experts.map((_, index) => `cap-${index}`), domains: [], projectSignals: [], risk: "standard", reviewAfter: 6,
    });
    expect(result.selected).toHaveLength(8);
    expect(result.requiresPlanReview).toBe(true);
  });

  it("batches all selected experts by a runtime concurrency limit", () => {
    const selected = Array.from({ length: 8 }, (_, index) => ({ expert: { ...translated, id: `ezagent.test.expert-${index}` }, score: 6, reasons: [`covers:cap-${index}`] }));
    expect(batchExpertSelection(selected, 3).map((batch) => batch.length)).toEqual([3, 3, 2]);
  });
});
```

- [ ] **Step 2: Implement coverage-based scoring**

```ts
// src/experts/selector.ts
import { parseExpert, type Expert } from "./expert.js";
import type { RiskLevel } from "../domain/work-item.js";

export interface SelectionRequest {
  capabilities: string[];
  domains: string[];
  projectSignals: string[];
  risk: RiskLevel;
  reviewAfter: number;
}

export interface SelectedExpert { expert: Expert; score: number; reasons: string[] }
export interface SelectionResult { selected: SelectedExpert[]; uncoveredCapabilities: string[]; requiresPlanReview: boolean }

export function batchExpertSelection(selected: SelectedExpert[], concurrencyLimit: number): SelectedExpert[][] {
  if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1) throw new Error("concurrencyLimit must be a positive integer");
  return Array.from({ length: Math.ceil(selected.length / concurrencyLimit) }, (_, index) =>
    selected.slice(index * concurrencyLimit, (index + 1) * concurrencyLimit),
  );
}

export function selectExperts(values: unknown[], request: SelectionRequest): SelectionResult {
  const experts = values.map(parseExpert);
  const uncovered = new Set(request.capabilities);
  const selected: SelectedExpert[] = [];
  while (uncovered.size > 0) {
    const ranked = experts
      .filter((expert) => !selected.some((item) => item.expert.id === expert.id))
      .map((expert) => {
        const covered = expert.capabilities.filter((capability) => uncovered.has(capability));
        const domainHits = expert.domains.filter((domain) => request.domains.includes(domain));
        const signalHits = expert.projectSignals.filter((signal) => request.projectSignals.includes(signal));
        const score = covered.length * 6 + domainHits.length * 4 + signalHits.length * 2 + (request.risk === "high" && expert.preferredTasks.includes("review") ? 2 : 0);
        return { expert, score, covered, reasons: [...covered.map((item) => `covers:${item}`), ...domainHits.map((item) => `domain:${item}`), ...signalHits.map((item) => `signal:${item}`)] };
      })
      .filter((item) => item.covered.length > 0)
      .sort((a, b) =>
        b.covered.length - a.covered.length ||
        b.score - a.score ||
        (a.expert.id < b.expert.id ? -1 : a.expert.id > b.expert.id ? 1 : 0),
      );
    const best = ranked[0];
    if (!best) break;
    selected.push({ expert: best.expert, score: best.score, reasons: best.reasons });
    best.covered.forEach((capability) => uncovered.delete(capability));
  }
  return { selected, uncoveredCapabilities: [...uncovered].sort(), requiresPlanReview: selected.length > request.reviewAfter };
}
```

**Product correction:** rank newly covered capability count first, then the existing
`6/4/2/+2` score, then expert id in portable code-unit order. Soft domain, signal,
or review matches must not outrank greater new coverage and cause avoidable expert
expansion; the selected count remains adaptive rather than fixed.

- [ ] **Step 3: Add dynamic expansion behavior**

```ts
export function expandExpertSelection(
  current: SelectionResult,
  catalog: unknown[],
  request: SelectionRequest,
): SelectionResult {
  const currentIds = new Set(current.selected.map((item) => item.expert.id));
  const remainingCatalog = catalog.map(parseExpert).filter((expert) => !currentIds.has(expert.id));
  const needed = [...new Set([...current.uncoveredCapabilities, ...request.capabilities])]
    .filter((capability) => !current.selected.some((item) => item.expert.capabilities.includes(capability)));
  const expansion = selectExperts(remainingCatalog, { ...request, capabilities: needed });
  const selected = [...current.selected, ...expansion.selected];
  return {
    selected,
    uncoveredCapabilities: expansion.uncoveredCapabilities,
    requiresPlanReview: selected.length > request.reviewAfter,
  };
}
```

Neither function has a `maxExperts` argument. The soft review threshold never truncates the result, and `concurrencyLimit` limits only simultaneous execution: every selected expert remains scheduled in an ordered batch.

- [ ] **Step 4: Verify selector and commit**

Run: `npm test -- test/experts/selector.test.ts && npm run check`

Expected: PASS; the 8-capability test selects all 8 experts, requests review rather than truncating, and schedules all 8 across the supplied runtime batch size.

```bash
git add src/experts/selector.ts test/experts/selector.test.ts
git commit -m "feat: select experts by adaptive coverage"
```

### Task 6: Persist active project experts with revisions

**Files:**
- Create: `src/experts/active.ts`
- Test: `test/experts/active.test.ts`

- [ ] **Step 1: Write a failing active-expert test**

```ts
// test/experts/active.test.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActiveExpertRepository } from "../../src/experts/active.js";

describe("ActiveExpertRepository", () => {
  it("rejects stale expert updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-active-"));
    const repository = new ActiveExpertRepository(root);
    await repository.write({ revision: 1, experts: [{ id: "ezagent.engineering.frontend-architect", reason: "covers frontend", taskIds: ["TASK-20260820-001"] }] }, 0);
    await expect(repository.write({ revision: 2, experts: [] }, 0)).rejects.toThrow("revision conflict");
  });
});
```

- [ ] **Step 2: Implement revisioned YAML persistence**

```ts
// src/experts/active.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { atomicWriteText } from "../workspace/atomic-write.js";
import { withWorkspaceLock } from "../workspace/lock.js";

const activeSchema = z.object({
  revision: z.number().int().nonnegative(),
  experts: z.array(z.object({
    id: z.string().regex(/^ezagent\./),
    reason: z.string().min(1),
    taskIds: z.array(z.string().regex(/^TASK-\d{8}-\d{3,}$/)).min(1),
  })),
});
export type ActiveExperts = z.infer<typeof activeSchema>;

export class ActiveExpertRepository {
  constructor(private readonly projectRoot: string) {}
  private get path(): string { return join(this.projectRoot, ".ezagent", "experts", "active.yaml"); }

  async read(): Promise<ActiveExperts> {
    try { return activeSchema.parse(parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, experts: [] };
      throw error;
    }
  }

  async write(next: ActiveExperts, expectedRevision: number): Promise<void> {
    await withWorkspaceLock(this.projectRoot, async () => {
      const current = await this.read();
      if (current.revision !== expectedRevision) throw new Error(`revision conflict: expected ${expectedRevision}, actual ${current.revision}`);
      if (next.revision !== expectedRevision + 1) throw new Error("active expert revision must increment by one");
      await atomicWriteText(this.path, stringify(activeSchema.parse(next)));
    });
  }
}
```

- [ ] **Step 3: Verify persistence and commit**

Run: `npm test -- test/experts/active.test.ts && npm run check`

Expected: PASS; stale updates fail without altering the first file.

```bash
git add src/experts/active.ts test/experts/active.test.ts
git commit -m "feat: persist active project experts"
```

### Task 7: Produce and verify the real offline snapshot

**Files:**
- Generate: `catalog/sources.lock.json`
- Generate: `catalog/normalized/experts.json`
- Generate: `catalog/normalized/catalog.lock.json`
- Modify: `catalog/taxonomy.yaml`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `licenses/*.txt`

- [ ] **Step 1: Request approval for release-time network access**

Explain that this step clones two public MIT repositories into ignored `vendor-sources/` solely to create the packaged offline snapshot. Do not proceed without approval.

- [ ] **Step 2: Clone and check out the reviewed refs**

```bash
git clone https://github.com/msitarzewski/agency-agents vendor-sources/agency-agents
git -C vendor-sources/agency-agents checkout 3f78a30
git clone https://github.com/jnMetaCode/agency-agents-zh vendor-sources/agency-agents-zh
git -C vendor-sources/agency-agents-zh checkout main
```

Expected: both are complete clones without partial-clone/promisor configuration. The English checkout is pinned to the recorded upstream base and the Chinese checkout is at the reviewed current `main`; both contain MIT license files. The next step converts both working trees into immutable full SHAs before import.

- [ ] **Step 3: Resolve immutable locks**

Run: `npm run catalog:lock`

Expected: `catalog/sources.lock.json` contains exactly two records, each with a full 40-character commit SHA and a `LICENSE` path/OID/raw-size/SHA-256 attestation read from that immutable commit object rather than either working tree. The later catalog verification must require the checked-in license bytes to match those attestations exactly, including the Chinese repository's resolved locked commit.

- [ ] **Step 4: Run normalization and close taxonomy gaps**

Run: `npm run catalog:import`

Expected on the first pass: either success or deterministic lists of unmapped source divisions and expert paths. Curate every reported entry in `catalog/taxonomy.yaml`, review the mapping against the expert's Chinese definition, rerun, and stop only when import exits `0` with no unknown divisions, missing/extra expert mappings, or duplicate IDs. The successful import must deterministically regenerate both `catalog/normalized/experts.json` and `catalog/normalized/catalog.lock.json`; rerun it and require both files to remain byte-identical before release.

**Release evidence correction:** the locked Chinese `main` contains 268 agent-list entries, including two China-original additions after the older 266-entry `UPSTREAM.md` baseline. Three listed files (`specialized/recruitment-specialist.md`, `specialized/specialized-french-consulting-market.md`, and `specialized/specialized-korean-business-navigator.md`) have Chinese metadata/headings but their substantive instructions are not yet localized into Chinese, so they remain explicitly classified as reviewed ignores rather than weakening the Chinese-content gate. The usable offline snapshot is therefore 265 experts: 212 attested translations (including two reviewed legacy translations that share a current upstream definition) and 53 explicit China-original definitions.

- [ ] **Step 5: Verify the complete snapshot**

Run: `npm run catalog:verify && npm run test:experts`

Expected: exit `0`, a measured non-zero expert count, 0 provenance errors, 0 duplicate IDs, and valid notices for every record.

- [ ] **Step 6: Commit only normalized outputs and notices**

```bash
git add catalog/sources.lock.json catalog/normalized/experts.json catalog/normalized/catalog.lock.json catalog/taxonomy.yaml THIRD_PARTY_NOTICES.md licenses
git commit -m "data: add normalized Chinese expert catalog"
```

Confirm `git status --short` does not show `vendor-sources/` and no upstream source tree is committed.
