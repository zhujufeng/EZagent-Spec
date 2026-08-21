import { constants, type Stats } from "node:fs";
import {
  access,
  appendFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  nodeProjectAgentRuntime,
  inspectProjectAgents,
  renderProjectAgent,
  syncProjectAgents,
  type ProjectAgentRuntime,
  type RenderedProjectAgent,
} from "../../src/adapters/codex/project-agent.js";
import { ActiveExpertRepository } from "../../src/experts/active.js";
import { WorkspaceRepository } from "../../src/workspace/repository.js";
import * as projectAgentApi from "../../src/adapters/codex/project-agent.js";

const translated: unknown = JSON.parse(
  await readFile(new URL("../fixtures/experts/translated.json", import.meta.url), "utf8"),
);
const backendExpert: unknown = {
  ...(translated as Record<string, unknown>),
  id: "ezagent.engineering.backend-architect",
  nameZh: "后端架构师",
  summaryZh: "负责后端边界、接口和可靠性设计。",
  instructionsZh: "基于项目证据分析后端结构，只在绑定任务范围内给出结论。",
  source: {
    ...((translated as Record<string, unknown>).source as Record<string, unknown>),
    path: "engineering/backend-architect.md",
  },
  upstreamSource: {
    ...((translated as Record<string, unknown>).upstreamSource as Record<string, unknown>),
    path: "engineering/backend-architect.md",
  },
  contentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};
const roots: string[] = [];

async function temporaryRoot(label = "ezagent-project-agent-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function assignment(mode: "analysis" | "review" | "implement" = "review") {
  return {
    taskIds: ["TASK-20260820-001"],
    mode,
    reason: "独立前端审查",
    scope: ["只检查前端状态边界"],
    deliverables: ["提交带证据的审查结论"],
    qualityGates: ["覆盖失败路径"],
  } as const;
}

function rendered(mode: "analysis" | "review" | "implement" = "review"): RenderedProjectAgent {
  return renderProjectAgent(translated, assignment(mode));
}

function backendRendered(): RenderedProjectAgent {
  return renderProjectAgent(backendExpert, {
    ...assignment("implement"),
    reason: "实现后端可靠性边界",
    scope: ["只实现后端接口边界"],
  });
}

describe("inspectProjectAgents", () => {
  it("reports pending before synchronization and ready afterward", async () => {
    const root = await initializedRoot();
    const desired = [rendered()];
    await expect(inspectProjectAgents(root, desired)).resolves.toMatchObject({ status: "pending" });
    await syncProjectAgents(root, desired);
    await expect(inspectProjectAgents(root, desired)).resolves.toMatchObject({ status: "ready" });
  });
});

function namedRendered(slug: "a" | "z"): RenderedProjectAgent {
  return renderProjectAgent({
    ...(translated as Record<string, unknown>),
    id: `ezagent.engineering.${slug}`,
    nameZh: `执行顺序专家${slug.toUpperCase()}`,
    source: {
      ...((translated as Record<string, unknown>).source as Record<string, unknown>),
      path: `engineering/${slug}.md`,
    },
    upstreamSource: {
      ...((translated as Record<string, unknown>).upstreamSource as Record<string, unknown>),
      path: `engineering/${slug}.md`,
    },
  }, assignment("review"));
}

function boundedItems(prefix: string, count: number, length = 4_000): readonly string[] {
  return Array.from({ length: count }, (_value, index) => {
    const marker = `${prefix}-${String(index).padStart(3, "0")}-`;
    return `${marker}${"x".repeat(length - marker.length)}`;
  });
}

function nearLimitAssignment(index = 0) {
  return {
    taskIds: [`TASK-20260820-${String(index + 1).padStart(3, "0")}`],
    mode: "review" as const,
    reason: `预算边界审查-${index}`,
    scope: boundedItems("scope", 128),
    deliverables: boundedItems("deliverable", 100),
    qualityGates: boundedItems("gate", 10),
  };
}

function budgetExpert(index: number): unknown {
  return {
    ...(translated as Record<string, unknown>),
    id: `ezagent.engineering.budget-${index}`,
    nameZh: `预算专家${index}`,
    source: {
      ...((translated as Record<string, unknown>).source as Record<string, unknown>),
      path: `engineering/budget-${index}.md`,
    },
    upstreamSource: {
      ...((translated as Record<string, unknown>).upstreamSource as Record<string, unknown>),
      path: `engineering/budget-${index}.md`,
    },
  };
}

function budgetRendered(count: number): readonly RenderedProjectAgent[] {
  return Array.from({ length: count }, (_value, index) => (
    renderProjectAgent(budgetExpert(index), nearLimitAssignment(index))
  ));
}

async function initializedRoot(active = true): Promise<string> {
  const root = await temporaryRoot();
  await new WorkspaceRepository(root).initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
  if (active) {
    await new ActiveExpertRepository(root).write({
      revision: 1,
      experts: [{
        id: "ezagent.engineering.frontend-architect",
        reason: "独立前端审查",
        taskIds: ["TASK-20260820-001"],
      }],
    }, 0);
  }
  return root;
}

function injectedRuntime(overrides: Partial<ProjectAgentRuntime>): ProjectAgentRuntime {
  return { ...nodeProjectAgentRuntime, ...overrides };
}

async function virtualLimitRuntime(
  root: string,
  options: {
    readonly runCount: number;
    readonly evidenceCount: number;
    readonly agentEntryCount: number;
  },
): Promise<{
  readonly runtime: ProjectAgentRuntime;
  readonly recoveryRoot: string;
  readonly agents: string;
}> {
  if (options.evidenceCount > 0 && options.runCount === 0) {
    throw new Error("virtual recovery evidence requires at least one run");
  }
  const recoveryRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
  const agents = join(root, ".codex", "agents");
  const templateDirectory = join(root, ".virtual-limit-directory");
  const templateFile = join(root, ".virtual-limit-evidence");
  await mkdir(recoveryRoot, { recursive: true });
  await mkdir(templateDirectory);
  await writeFile(templateFile, "", "utf8");
  if (options.agentEntryCount > 0) await mkdir(agents, { recursive: true });
  const [templateDirectoryStat, templateFileStat] = await Promise.all([
    lstat(templateDirectory),
    lstat(templateFile),
  ]);
  const runNames = Array.from({ length: options.runCount }, (_value, index) => (
    `run-${String(index + 1).padStart(24, "0")}`
  ));
  const entriesByRun = new Map<string, string[]>(
    runNames.map((name) => [join(recoveryRoot, name), []]),
  );
  const evidencePaths = new Set<string>();
  for (let index = 0; index < options.evidenceCount; index += 1) {
    const runPath = join(recoveryRoot, runNames[index % runNames.length]!);
    const entry = `${index}.ezagent-virtual-${index}.toml.next`;
    entriesByRun.get(runPath)!.push(entry);
    evidencePaths.add(join(runPath, entry));
  }
  const agentEntries = Array.from(
    { length: options.agentEntryCount },
    (_value, index) => `user-${index}.toml`,
  );
  const runtime = injectedRuntime({
    lstat: async (path) => {
      if (entriesByRun.has(path)) return templateDirectoryStat;
      if (evidencePaths.has(path)) return templateFileStat;
      return nodeProjectAgentRuntime.lstat(path);
    },
    open: async (path, flags, mode) => {
      if (evidencePaths.has(path)) return nodeProjectAgentRuntime.open(templateFile, flags, mode);
      return nodeProjectAgentRuntime.open(path, flags, mode);
    },
    readdir: async (path) => {
      if (path === recoveryRoot) return [...runNames];
      const entries = entriesByRun.get(path);
      if (entries !== undefined) return [...entries];
      if (path === agents) return [...agentEntries];
      return nodeProjectAgentRuntime.readdir(path);
    },
  });
  return { runtime, recoveryRoot, agents };
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function manifest(root: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, ".ezagent", "experts", "generated-codex.json"), "utf8"));
}

describe("Codex project expert rendering", () => {
  it("keeps the public rendering and synchronization API surface stable", () => {
    expect(Object.keys(projectAgentApi).sort()).toEqual([
      "ProjectAgentInspectionRequiredError",
      "inspectProjectAgents",
      "nodeProjectAgentRuntime",
      "renderProjectAgent",
      "syncProjectAgents",
    ]);
  });

  it.each([
    ["analysis", "read-only"],
    ["review", "read-only"],
    ["implement", "workspace-write"],
  ] as const)("renders an assignment-bound %s expert", (mode, sandbox) => {
    const result = rendered(mode);

    expect(result.fileName).toBe("ezagent-engineering-frontend-architect.toml");
    expect(result.content).toContain(`sandbox_mode = ${JSON.stringify(sandbox)}`);
    expect(result.content).toContain("前端架构师");
    expect(result.content).toContain("基于项目证据分析前端结构");
    expect(result.content).toContain("TASK-20260820-001");
    expect(result.content).toContain("独立前端审查");
    expect(result.content).toContain("只检查前端状态边界");
    expect(result.content).toContain("提交带证据的审查结论");
    expect(result.content).toContain("覆盖失败路径");
    expect(result.content).toContain("不得自行推进 EZagent 状态");
    expect(result.content).toBe([
      'name = "前端架构师"',
      'description = "负责前端边界、状态和可维护性设计。"',
      `sandbox_mode = ${JSON.stringify(sandbox)}`,
      'developer_instructions = "你是项目级专家「前端架构师」。\\n\\n负责前端边界、状态和可维护性设计。\\n\\n基于项目证据分析前端结构，只在任务范围内给出结论。\\n\\n绑定 Task IDs：\\n- TASK-20260820-001\\n\\n启用模式：'
        + `${mode}\\n\\n选择原因：独立前端审查\\n\\n工作范围：\\n- 只检查前端状态边界\\n\\n交付物：\\n- 提交带证据的审查结论\\n\\n专家质量门：\\n- 引用实际文件\\n- 覆盖错误状态\\n\\n本次质量门：\\n- 覆盖失败路径\\n\\n只能在上述任务、范围与权限内工作；必须基于项目证据输出。不得自行推进 EZagent 状态，任何状态迁移只能由结构化工作流执行。"`,
      "",
    ].join("\n"));
    if (mode === "review") {
      expect(result.sha256).toBe("sha256:8f7e5b09f8ff705da471f4324e254466f30710ace4164d6d60928934dc9d1b68");
    } else {
      expect(result.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
  });

  it("parses experts and snapshots a bounded assignment before rendering", () => {
    expect(() => renderProjectAgent({ ...(translated as object), id: "unsafe" }, assignment()))
      .toThrow(/invalid expert/iu);
    expect(() => renderProjectAgent(translated, { ...assignment(), taskIds: [] }))
      .toThrow(/assignment|task/iu);
    expect(() => renderProjectAgent(translated, {
      ...assignment(),
      unexpected: "value",
    } as never)).toThrow(/assignment|unsupported/iu);

    const source = assignment();
    const proxied = new Proxy(source, {});
    expect(() => renderProjectAgent(translated, proxied)).toThrow(/proxy|assignment/iu);
  });

  it.each([
    "REQ-20260820-001",
    "SPEC-20260820-001",
    "ADR-20260820-001",
  ])("rejects non-TASK work item id %s", (taskId) => {
    expect(() => renderProjectAgent(translated, { ...assignment(), taskIds: [taskId] }))
      .toThrow(/assignment\.taskIds.*invalid/iu);
  });

  it("renders a near-maximum legal agent below the synchronization byte limit", () => {
    const result = renderProjectAgent(budgetExpert(0), nearLimitAssignment());
    const bytes = Buffer.byteLength(result.content, "utf8");

    expect(bytes).toBeGreaterThan(900_000);
    expect(bytes).toBeLessThanOrEqual(1_048_576);
  });

  it("rejects an aggregate assignment that would exceed the render byte contract", () => {
    expect(() => renderProjectAgent(budgetExpert(0), {
      ...nearLimitAssignment(),
      qualityGates: boundedItems("overflow", 40),
    })).toThrow(/assignment.*byte budget|rendered project agent.*byte/iu);
  });
});

describe("Codex project expert synchronization", () => {
  it("publishes only selected experts and preserves user files byte-for-byte", async () => {
    const root = await initializedRoot();
    const directory = join(root, ".codex", "agents");
    await mkdir(directory, { recursive: true });
    const userBytes = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
    await writeFile(join(directory, "user-reviewer.toml"), userBytes);

    await expect(syncProjectAgents(root, [rendered()])).resolves.toEqual({
      synced: true,
      files: ["ezagent-engineering-frontend-architect.toml"],
    });

    expect(await readFile(join(directory, "user-reviewer.toml"))).toEqual(userBytes);
    expect(await readFile(join(directory, "ezagent-engineering-frontend-architect.toml"), "utf8"))
      .toBe(rendered().content);
    expect(await manifest(root)).toEqual({
      schemaVersion: 1,
      files: {
        "ezagent-engineering-frontend-architect.toml": rendered().sha256,
      },
    });
    expect((await readdir(directory)).sort()).toEqual([
      "ezagent-engineering-frontend-architect.toml",
      "user-reviewer.toml",
    ]);
  });

  it("moves an exact stale owned agent into recovery and preserves unknown ezagent files", async () => {
    const root = await initializedRoot(false);
    const directory = join(root, ".codex", "agents");
    await mkdir(directory, { recursive: true });
    const old = rendered();
    await writeFile(join(directory, old.fileName), old.content, "utf8");
    await writeFile(join(directory, "ezagent-unknown.toml"), "unknown = true\n", "utf8");
    await writeFile(
      join(root, ".ezagent", "experts", "generated-codex.json"),
      `${JSON.stringify({ schemaVersion: 1, files: { [old.fileName]: old.sha256 } }, null, 2)}\n`,
      "utf8",
    );

    await syncProjectAgents(root, []);

    await expectMissing(join(directory, old.fileName));
    expect(await readFile(join(directory, "ezagent-unknown.toml"), "utf8"))
      .toBe("unknown = true\n");
    expect(await manifest(root)).toEqual({ schemaVersion: 1, files: {} });
    const recoveryRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
    const runs = await readdir(recoveryRoot);
    expect(runs).toHaveLength(1);
    const recovered = await readdir(join(recoveryRoot, runs[0]!));
    expect(recovered.some((name) => name.endsWith(`.${old.fileName}.bak`))).toBe(true);
  });

  it("retires an already-absent stale ownership without creating a Codex directory", async () => {
    const root = await initializedRoot(false);
    const stale = rendered();
    const manifestPath = join(root, ".ezagent", "experts", "generated-codex.json");
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      files: { [stale.fileName]: stale.sha256 },
    }, null, 2)}\n`, "utf8");

    await expect(syncProjectAgents(root, [])).resolves.toEqual({ synced: true, files: [] });

    expect(await manifest(root)).toEqual({ schemaVersion: 1, files: {} });
    await expectMissing(join(root, ".codex"));
    const recoveryRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
    const runs = await readdir(recoveryRoot);
    expect(runs).toHaveLength(1);
    expect((await readdir(join(recoveryRoot, runs[0]!))).sort()).toEqual([
      "generated-codex.json.bak",
      "generated-codex.json.next",
    ]);

    await expect(syncProjectAgents(root, [])).resolves.toEqual({ synced: true, files: [] });

    await expectMissing(join(root, ".codex"));
    expect(await readdir(recoveryRoot)).toEqual(runs);
  });

  it("rejects a stale target that disappears after the agents directory snapshot", async () => {
    const root = await initializedRoot(false);
    const stale = rendered();
    const agents = join(root, ".codex", "agents");
    const stalePath = join(agents, stale.fileName);
    const vanishedPath = join(root, "competitor-retained-stale.toml");
    const manifestPath = join(root, ".ezagent", "experts", "generated-codex.json");
    await mkdir(agents, { recursive: true });
    await writeFile(stalePath, stale.content, "utf8");
    const manifestBytes = `${JSON.stringify({
      schemaVersion: 1,
      files: { [stale.fileName]: stale.sha256 },
    }, null, 2)}\n`;
    await writeFile(manifestPath, manifestBytes, "utf8");
    let disappeared = false;
    const runtime = injectedRuntime({
      readdir: async (path) => {
        const entries = await nodeProjectAgentRuntime.readdir(path);
        if (path === agents && !disappeared) {
          disappeared = true;
          await rename(stalePath, vanishedPath);
        }
        return entries;
      },
    });

    await expect(syncProjectAgents(root, [], runtime))
      .rejects.toThrow(/Codex agents directory changed while planning/iu);

    expect(disappeared).toBe(true);
    await expectMissing(stalePath);
    expect(await readFile(vanishedPath, "utf8")).toBe(stale.content);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBytes);
    await expectMissing(join(root, ".ezagent", "backups", "generated-codex-agents"));
  });

  it("refuses a user-modified owned agent before creating recovery side effects", async () => {
    const root = await initializedRoot(false);
    const directory = join(root, ".codex", "agents");
    await mkdir(directory, { recursive: true });
    const old = rendered();
    await writeFile(join(directory, old.fileName), "modified = true\n", "utf8");
    await writeFile(join(directory, "user-reviewer.toml"), "user = true\n", "utf8");
    await writeFile(
      join(root, ".ezagent", "experts", "generated-codex.json"),
      `${JSON.stringify({ schemaVersion: 1, files: { [old.fileName]: old.sha256 } })}\n`,
      "utf8",
    );

    await expect(syncProjectAgents(root, [])).rejects.toThrow(/modified managed agent/iu);

    expect(await readFile(join(directory, old.fileName), "utf8")).toBe("modified = true\n");
    expect(await readFile(join(directory, "user-reviewer.toml"), "utf8")).toBe("user = true\n");
    await expectMissing(join(root, ".ezagent", "backups", "generated-codex-agents"));
  });

  it("does not adopt an exact but unowned ezagent file without retained publication evidence", async () => {
    const root = await initializedRoot();
    const directory = join(root, ".codex", "agents");
    await mkdir(directory, { recursive: true });
    const candidate = rendered();
    await writeFile(join(directory, candidate.fileName), candidate.content, "utf8");

    await expect(syncProjectAgents(root, [candidate])).rejects.toThrow(/unowned managed agent/iu);

    expect(await readFile(join(directory, candidate.fileName), "utf8")).toBe(candidate.content);
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
    await expectMissing(join(root, ".ezagent", "backups", "generated-codex-agents"));
  });

  it("requires desired assignments to match the active selection re-read inside the lock", async () => {
    const root = await initializedRoot(false);
    let insideLock = false;
    const runtime = injectedRuntime({
      withWorkspaceLock: async (_root, operation) => {
        insideLock = true;
        try {
          return await operation();
        } finally {
          insideLock = false;
        }
      },
      readActiveExperts: async () => {
        expect(insideLock).toBe(true);
        return { revision: 2, experts: [] };
      },
    });

    await expect(syncProjectAgents(root, [rendered()], runtime)).rejects.toThrow(/active expert/iu);
    await expectMissing(join(root, ".codex"));
  });

  it("binds the real workspace lock to the pre-lock project and workspace identities", async () => {
    const root = await initializedRoot();
    const workspace = join(root, ".ezagent");
    const displaced = join(root, "displaced-workspace");
    let swapped = false;
    const runtime = injectedRuntime({
      readActiveExperts: async () => {
        if (!swapped) {
          swapped = true;
          await rename(workspace, displaced);
          await mkdir(workspace);
          await writeFile(join(workspace, "sentinel"), "replacement workspace\n", "utf8");
        }
        return {
          revision: 1,
          experts: [{
            id: "ezagent.engineering.frontend-architect",
            reason: "独立前端审查",
            taskIds: ["TASK-20260820-001"],
          }],
        };
      },
    });

    await expect(syncProjectAgents(root, [rendered()], runtime)).rejects.toThrow(/workspace.*changed|identity/iu);

    expect(await readFile(join(workspace, "sentinel"), "utf8")).toBe("replacement workspace\n");
    await expectMissing(join(root, ".codex"));
  });

  it.each(["workspace", "codex", "agents", "manifest", "managed"] as const)(
    "rejects a symlinked %s boundary or file without following it",
    async (target) => {
      const root = await initializedRoot(false);
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "sentinel"), "outside bytes\n", "utf8");
      const workspace = join(root, ".ezagent");
      const codex = join(root, ".codex");
      const agents = join(codex, "agents");
      const manifestPath = join(workspace, "experts", "generated-codex.json");
      const managedPath = join(agents, rendered().fileName);

      if (target === "workspace") {
        const displaced = join(root, "workspace-real");
        await rename(workspace, displaced);
        await symlink(displaced, workspace, "dir");
      } else if (target === "codex") {
        await symlink(outside, codex, "dir");
      } else if (target === "agents") {
        await mkdir(codex);
        await symlink(outside, agents, "dir");
      } else if (target === "manifest") {
        await symlink(join(outside, "sentinel"), manifestPath);
      } else {
        await mkdir(agents, { recursive: true });
        await symlink(join(outside, "sentinel"), managedPath);
        await writeFile(manifestPath, `${JSON.stringify({
          schemaVersion: 1,
          files: { [rendered().fileName]: rendered().sha256 },
        })}\n`, "utf8");
      }

      await expect(syncProjectAgents(root, [], injectedRuntime({
        readActiveExperts: async () => ({ revision: 1, experts: [] }),
      }))).rejects.toThrow(/real directory|regular file|symlink|workspace/iu);
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("outside bytes\n");
    },
  );

  it("rejects an initially hard-linked managed file and manifest", async () => {
    const root = await initializedRoot(false);
    const directory = join(root, ".codex", "agents");
    await mkdir(directory, { recursive: true });
    const outsideAgent = join(root, "outside-agent");
    const outsideManifest = join(root, "outside-manifest");
    await writeFile(outsideAgent, rendered().content, "utf8");
    await link(outsideAgent, join(directory, rendered().fileName));
    const manifestBytes = `${JSON.stringify({ schemaVersion: 1, files: {
      [rendered().fileName]: rendered().sha256,
    } })}\n`;
    await writeFile(outsideManifest, manifestBytes, "utf8");
    await link(outsideManifest, join(root, ".ezagent", "experts", "generated-codex.json"));

    await expect(syncProjectAgents(root, [])).rejects.toThrow(/uniquely linked|regular file/iu);
    expect(await readFile(outsideAgent, "utf8")).toBe(rendered().content);
    expect(await readFile(outsideManifest, "utf8")).toBe(manifestBytes);
  });

  it("rejects portable case-fold collisions before lock or filesystem side effects", async () => {
    const root = await initializedRoot();
    let locked = false;
    const duplicate = {
      ...rendered(),
      fileName: "EZAGENT-ENGINEERING-FRONTEND-ARCHITECT.TOML",
    } as RenderedProjectAgent;
    const runtime = injectedRuntime({
      withWorkspaceLock: async (_root, operation) => {
        locked = true;
        return operation();
      },
    });

    await expect(syncProjectAgents(root, [rendered(), duplicate], runtime))
      .rejects.toThrow(/case-fold|portable|filename/iu);
    expect(locked).toBe(false);
    await expectMissing(join(root, ".codex"));
  });

  it("retains a durable next file when target publication partially fails", async () => {
    const root = await initializedRoot();
    const target = join(root, ".codex", "agents", rendered().fileName);
    const failure = Object.assign(new Error("injected partial publication"), { code: "EIO" });
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        const handle = await nodeProjectAgentRuntime.open(path, flags, mode);
        if (path !== target || flags !== "wx") return handle;
        return new Proxy(handle, {
          get(object, property, receiver) {
            if (property === "write") {
              return async (buffer: Uint8Array, offset: number, length: number, position: number | null) => {
                await object.write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
                throw failure;
              };
            }
            const value: unknown = Reflect.get(object, property, receiver);
            return typeof value === "function" ? value.bind(object) : value;
          },
        });
      },
    });

    let thrown: unknown;
    try {
      await syncProjectAgents(root, [rendered()], runtime);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "INSPECTION_REQUIRED" });
    expect((thrown as Error).message).toMatch(/requires inspection.*recovery:/iu);
    expect((await readFile(target)).length).toBeGreaterThan(0);
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
    const recoveryRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
    const run = (await readdir(recoveryRoot))[0]!;
    expect((await readdir(join(recoveryRoot, run))).some((name) => name.endsWith(".next"))).toBe(true);
  });

  it("does not accept a same-byte replacement after closing an exclusive publication handle", async () => {
    const root = await initializedRoot();
    const target = join(root, ".codex", "agents", rendered().fileName);
    const displaced = `${target}.displaced`;
    let replaced = false;
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        const handle = await nodeProjectAgentRuntime.open(path, flags, mode);
        if (path !== target || flags !== "wx") return handle;
        return new Proxy(handle, {
          get(object, property, receiver) {
            if (property === "close") {
              return async () => {
                await object.close();
                if (!replaced) {
                  replaced = true;
                  const bytes = await readFile(target);
                  await rename(target, displaced);
                  await writeFile(target, bytes);
                }
              };
            }
            const value: unknown = Reflect.get(object, property, receiver);
            return typeof value === "function" ? value.bind(object) : value;
          },
        });
      },
    });

    await expect(syncProjectAgents(root, [rendered()], runtime))
      .rejects.toMatchObject({ code: "INSPECTION_REQUIRED" });

    expect(await readFile(target)).toEqual(await readFile(displaced));
    const [current, original] = await Promise.all([lstat(target), lstat(displaced)]);
    expect(`${current.dev}:${current.ino}`).not.toBe(`${original.dev}:${original.ino}`);
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
  });

  it.each([
    ["growth", async (path: string) => appendFile(path, "grow", "utf8")],
    ["shrink", async (path: string) => truncate(path, 1)],
  ])("rejects managed-agent %s through the public synchronization adapter", async (_case, mutate) => {
    const root = await initializedRoot();
    const desired = rendered();
    await syncProjectAgents(root, [desired]);
    const target = join(root, ".codex", "agents", desired.fileName);
    const manifestPath = join(root, ".ezagent", "experts", "generated-codex.json");
    const recoveryRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
    const [manifestBefore, recoveryBefore] = await Promise.all([
      readFile(manifestPath),
      readdir(recoveryRoot),
    ]);
    let mutated = false;
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        if (!mutated && path === target && typeof flags === "number") {
          mutated = true;
          await mutate(path);
        }
        return nodeProjectAgentRuntime.open(path, flags, mode);
      },
    });

    await expect(syncProjectAgents(root, [desired], runtime)).rejects.toThrow(/managed agent changed during read/iu);

    expect(mutated).toBe(true);
    expect(await readFile(manifestPath)).toEqual(manifestBefore);
    expect(await readdir(recoveryRoot)).toEqual(recoveryBefore);
    if (_case === "growth") {
      expect(await readFile(target, "utf8")).toBe(`${desired.content}grow`);
    } else {
      expect(await readFile(target)).toEqual(Buffer.from(desired.content, "utf8").subarray(0, 1));
    }
  });

  it("reports typed retained evidence when public managed-target close fails", async () => {
    const root = await initializedRoot();
    const desired = rendered();
    const target = join(root, ".codex", "agents", desired.fileName);
    const closeFailure = Object.assign(new Error("injected managed target close failure"), { code: "EIO" });
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        const handle = await nodeProjectAgentRuntime.open(path, flags, mode);
        if (path !== target || flags !== "wx") return handle;
        return new Proxy(handle, {
          get(object, property, receiver) {
            if (property === "close") {
              return async () => {
                await object.close();
                throw closeFailure;
              };
            }
            const value: unknown = Reflect.get(object, property, receiver);
            return typeof value === "function" ? value.bind(object) : value;
          },
        });
      },
    });

    let failure: unknown;
    try {
      await syncProjectAgents(root, [desired], runtime);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "ProjectAgentInspectionRequiredError",
      code: "INSPECTION_REQUIRED",
      operation: "managed no-clobber publication",
      cause: closeFailure,
      recoveryPath: expect.stringContaining("generated-codex-agents"),
      backupPath: undefined,
      runPath: expect.stringMatching(/run-[0-9a-f]{24}$/u),
      nextPath: expect.stringMatching(/\.next$/u),
    });
    const evidence = failure as {
      readonly recoveryPath: string;
      readonly runPath: string;
      readonly nextPath: string;
      readonly paths: readonly string[];
    };
    expect(evidence.paths).toEqual([
      evidence.recoveryPath,
      evidence.runPath,
      evidence.nextPath,
    ]);
    expect(await readFile(target, "utf8")).toBe(desired.content);
    expect(await readFile(evidence.nextPath, "utf8")).toBe(desired.content);
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
  });

  it("reports ambiguous rename with concrete evidence and never deletes either path", async () => {
    const root = await initializedRoot(false);
    const directory = join(root, ".codex", "agents");
    await mkdir(directory, { recursive: true });
    const old = rendered();
    const source = join(directory, old.fileName);
    await writeFile(source, old.content, "utf8");
    await writeFile(
      join(root, ".ezagent", "experts", "generated-codex.json"),
      `${JSON.stringify({ schemaVersion: 1, files: { [old.fileName]: old.sha256 } })}\n`,
      "utf8",
    );
    const ambiguous = Object.assign(new Error("ambiguous rename"), { code: "EIO" });
    let backupPath: string | undefined;
    const runtime = injectedRuntime({
      rename: async (from, to) => {
        backupPath = to;
        await nodeProjectAgentRuntime.rename(from, to);
        throw ambiguous;
      },
    });

    let thrown: unknown;
    try {
      await syncProjectAgents(root, [], runtime);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "INSPECTION_REQUIRED", backupPath });
    expect(backupPath).toBeDefined();
    expect(await readFile(backupPath!, "utf8")).toBe(old.content);
    await expectMissing(source);
  });

  it("restores a concurrently replaced source by no-clobber copy and requires inspection", async () => {
    const root = await initializedRoot(false);
    const directory = join(root, ".codex", "agents");
    await mkdir(directory, { recursive: true });
    const old = rendered();
    const source = join(directory, old.fileName);
    await writeFile(source, old.content, "utf8");
    await writeFile(
      join(root, ".ezagent", "experts", "generated-codex.json"),
      `${JSON.stringify({ schemaVersion: 1, files: { [old.fileName]: old.sha256 } })}\n`,
      "utf8",
    );
    let injected = false;
    const runtime = injectedRuntime({
      rename: async (from, to) => {
        if (!injected && from === source) {
          injected = true;
          await rename(from, `${from}.original`);
          await writeFile(from, "competitor bytes\n", "utf8");
        }
        await nodeProjectAgentRuntime.rename(from, to);
      },
    });

    await expect(syncProjectAgents(root, [], runtime)).rejects.toMatchObject({ code: "INSPECTION_REQUIRED" });

    expect(await readFile(source, "utf8")).toBe("competitor bytes\n");
    expect(await readFile(`${source}.original`, "utf8")).toBe(old.content);
  });

  it("detects recovery ancestor replacement before publishing managed files", async () => {
    const root = await initializedRoot();
    const backupRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
    const displaced = join(root, "displaced-backups");
    let injected = false;
    const runtime = injectedRuntime({
      mkdir: async (path) => {
        await nodeProjectAgentRuntime.mkdir(path);
        if (!injected && path === backupRoot) {
          injected = true;
          await rename(join(root, ".ezagent", "backups"), displaced);
          await symlink(displaced, join(root, ".ezagent", "backups"), "dir");
        }
      },
    });

    await expect(syncProjectAgents(root, [rendered()], runtime))
      .rejects.toMatchObject({ code: "INSPECTION_REQUIRED" });
    await expectMissing(join(root, ".codex", "agents", rendered().fileName));
  });

  it("does not claim success when manifest publication fails and a retry adopts exact desired files", async () => {
    const root = await initializedRoot();
    const manifestPath = join(root, ".ezagent", "experts", "generated-codex.json");
    const failure = Object.assign(new Error("manifest unavailable"), { code: "EIO" });
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        if (path === manifestPath && flags === "wx") throw failure;
        return nodeProjectAgentRuntime.open(path, flags, mode);
      },
    });

    await expect(syncProjectAgents(root, [rendered()], runtime))
      .rejects.toMatchObject({ code: "INSPECTION_REQUIRED" });
    expect(await readFile(join(root, ".codex", "agents", rendered().fileName), "utf8"))
      .toBe(rendered().content);
    await expectMissing(manifestPath);

    await expect(syncProjectAgents(root, [rendered()])).resolves.toEqual({
      synced: true,
      files: [rendered().fileName],
    });
    expect(await manifest(root)).toEqual({
      schemaVersion: 1,
      files: { [rendered().fileName]: rendered().sha256 },
    });
  });

  it("reports retained per-file evidence when retrying a multi-agent partial publication", async () => {
    const root = await initializedRoot(false);
    const front = rendered();
    const back = backendRendered();
    await new ActiveExpertRepository(root).write({
      revision: 1,
      experts: [
        { id: front.expertId, reason: front.assignment.reason, taskIds: front.assignment.taskIds },
        { id: back.expertId, reason: back.assignment.reason, taskIds: back.assignment.taskIds },
      ],
    }, 0);
    const partialTarget = join(root, ".codex", "agents", front.fileName);
    const failure = Object.assign(new Error("second target partial failure"), { code: "EIO" });
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        const handle = await nodeProjectAgentRuntime.open(path, flags, mode);
        if (path !== partialTarget || flags !== "wx") return handle;
        return new Proxy(handle, {
          get(object, property, receiver) {
            if (property === "write") {
              return async (buffer: Uint8Array, offset: number, length: number, position: number | null) => {
                await object.write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
                throw failure;
              };
            }
            const value: unknown = Reflect.get(object, property, receiver);
            return typeof value === "function" ? value.bind(object) : value;
          },
        });
      },
    });

    await expect(syncProjectAgents(root, [back, front], runtime))
      .rejects.toMatchObject({ code: "INSPECTION_REQUIRED" });

    let retryFailure: unknown;
    try {
      await syncProjectAgents(root, [back, front]);
    } catch (error: unknown) {
      retryFailure = error;
    }
    expect(retryFailure).toMatchObject({ code: "INSPECTION_REQUIRED" });
    expect((retryFailure as Error).message).toMatch(/recovery:.*generated-codex-agents.*run:.*run-.*next:.*\.next.*backup:/iu);
    expect(await readFile(join(root, ".codex", "agents", back.fileName), "utf8")).toBe(back.content);
    expect((await readFile(partialTarget)).length).toBeGreaterThan(0);
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
  });

  it("reports complete update evidence when a prior-hash target is partially replaced", async () => {
    const root = await initializedRoot();
    const review = rendered("review");
    const implementation = rendered("implement");
    await syncProjectAgents(root, [review]);
    const target = join(root, ".codex", "agents", review.fileName);
    const injectedFailure = Object.assign(new Error("partial expert update"), { code: "EIO" });
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        const handle = await nodeProjectAgentRuntime.open(path, flags, mode);
        if (path !== target || flags !== "wx") return handle;
        return new Proxy(handle, {
          get(object, property, receiver) {
            if (property === "write") {
              return async (buffer: Uint8Array, offset: number, length: number, position: number | null) => {
                await object.write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
                throw injectedFailure;
              };
            }
            const value: unknown = Reflect.get(object, property, receiver);
            return typeof value === "function" ? value.bind(object) : value;
          },
        });
      },
    });

    let firstFailure: unknown;
    try {
      await syncProjectAgents(root, [implementation], runtime);
    } catch (error: unknown) {
      firstFailure = error;
    }
    expect(firstFailure).toMatchObject({
      code: "INSPECTION_REQUIRED",
      runPath: expect.stringContaining("run-"),
      nextPath: expect.stringMatching(/\.next$/u),
      backupPath: expect.stringMatching(/\.bak$/u),
    });

    let retryFailure: unknown;
    try {
      await syncProjectAgents(root, [implementation]);
    } catch (error: unknown) {
      retryFailure = error;
    }
    expect(retryFailure).toMatchObject({
      code: "INSPECTION_REQUIRED",
      recoveryPath: expect.stringContaining("generated-codex-agents"),
      runPath: expect.stringContaining("run-"),
      nextPath: expect.stringMatching(/\.next$/u),
      backupPath: expect.stringMatching(/\.bak$/u),
    });
    const evidence = retryFailure as {
      readonly paths: readonly string[];
      readonly recoveryPath: string;
      readonly runPath: string;
      readonly nextPath: string;
      readonly backupPath: string;
    };
    expect(evidence.paths).toEqual([
      evidence.recoveryPath,
      evidence.runPath,
      evidence.nextPath,
      evidence.backupPath,
    ]);
    await expect(access(evidence.recoveryPath)).resolves.toBeUndefined();
    await expect(access(evidence.runPath)).resolves.toBeUndefined();
    expect(await readFile(evidence.nextPath, "utf8")).toBe(implementation.content);
    expect(await readFile(evidence.backupPath, "utf8")).toBe(review.content);
    const partial = await readFile(target, "utf8");
    expect(partial.length).toBeGreaterThan(0);
    expect(partial).not.toBe(implementation.content);
  });

  it("uses stale-owned backup evidence when a competitor occupies the moved target", async () => {
    const root = await initializedRoot();
    const review = rendered("review");
    await syncProjectAgents(root, [review]);
    await new ActiveExpertRepository(root).write({ revision: 2, experts: [] }, 1);
    const target = join(root, ".codex", "agents", review.fileName);
    const manifestPath = join(root, ".ezagent", "experts", "generated-codex.json");
    const injectedFailure = Object.assign(new Error("stop before manifest move"), { code: "EIO" });
    const runtime = injectedRuntime({
      rename: async (from, to) => {
        if (from === manifestPath) throw injectedFailure;
        await nodeProjectAgentRuntime.rename(from, to);
      },
    });

    await expect(syncProjectAgents(root, [], runtime))
      .rejects.toMatchObject({ code: "INSPECTION_REQUIRED" });
    await expectMissing(target);
    await writeFile(target, "competitor bytes stay\n", "utf8");

    let retryFailure: unknown;
    try {
      await syncProjectAgents(root, []);
    } catch (error: unknown) {
      retryFailure = error;
    }
    expect(retryFailure).toMatchObject({
      code: "INSPECTION_REQUIRED",
      recoveryPath: expect.stringContaining("generated-codex-agents"),
      runPath: expect.stringContaining("run-"),
      nextPath: undefined,
      backupPath: expect.stringMatching(/\.bak$/u),
    });
    const evidence = retryFailure as {
      readonly recoveryPath: string;
      readonly runPath: string;
      readonly backupPath: string;
      readonly paths: readonly string[];
    };
    expect(evidence.paths).toEqual([
      evidence.recoveryPath,
      evidence.runPath,
      evidence.backupPath,
    ]);
    expect(await readFile(target, "utf8")).toBe("competitor bytes stay\n");
    expect(await readFile(evidence.backupPath, "utf8")).toBe(review.content);
    expect(await readFile(manifestPath, "utf8")).toContain(review.fileName);
  });

  it("indexes canonical manifest next evidence before parsing a partial manifest", async () => {
    const root = await initializedRoot();
    const desired = rendered();
    const manifestPath = join(root, ".ezagent", "experts", "generated-codex.json");
    const injectedFailure = Object.assign(new Error("partial manifest publication"), { code: "EIO" });
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        const handle = await nodeProjectAgentRuntime.open(path, flags, mode);
        if (path !== manifestPath || flags !== "wx") return handle;
        return new Proxy(handle, {
          get(object, property, receiver) {
            if (property === "write") {
              return async (buffer: Uint8Array, offset: number, length: number, position: number | null) => {
                await object.write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
                throw injectedFailure;
              };
            }
            const value: unknown = Reflect.get(object, property, receiver);
            return typeof value === "function" ? value.bind(object) : value;
          },
        });
      },
    });

    await expect(syncProjectAgents(root, [desired], runtime))
      .rejects.toMatchObject({ code: "INSPECTION_REQUIRED" });
    const partialBeforeRetry = await readFile(manifestPath);

    let retryFailure: unknown;
    try {
      await syncProjectAgents(root, [desired]);
    } catch (error: unknown) {
      retryFailure = error;
    }
    expect(retryFailure).toMatchObject({
      code: "INSPECTION_REQUIRED",
      recoveryPath: expect.stringContaining("generated-codex-agents"),
      runPath: expect.stringContaining("run-"),
      nextPath: expect.stringMatching(/generated-codex\.json\.next$/u),
      backupPath: undefined,
    });
    const evidence = retryFailure as { readonly nextPath: string };
    expect(await readFile(manifestPath)).toEqual(partialBeforeRetry);
    expect(await readFile(evidence.nextPath, "utf8")).toBe(`${JSON.stringify({
      schemaVersion: 1,
      files: { [desired.fileName]: desired.sha256 },
    }, null, 2)}\n`);
  });

  it("fails closed on a symlinked recovery evidence entry", async () => {
    const root = await initializedRoot();
    const desired = rendered();
    await syncProjectAgents(root, [desired]);
    const target = join(root, ".codex", "agents", desired.fileName);
    const recoveryRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
    const run = (await readdir(recoveryRoot))[0]!;
    await symlink(target, join(recoveryRoot, run, `99.${desired.fileName}.bak`));
    const before = await readFile(target);

    await expect(syncProjectAgents(root, [desired])).rejects.toThrow(/recovery evidence.*regular file/iu);

    expect(await readFile(target)).toEqual(before);
  });

  it("fails closed when a recovery run enumeration exceeds its bound", async () => {
    const root = await initializedRoot();
    const desired = rendered();
    await syncProjectAgents(root, [desired]);
    const target = join(root, ".codex", "agents", desired.fileName);
    const before = await readFile(target);
    const runtime = injectedRuntime({
      readdir: async (path) => {
        if (path.split(/[/\\]/u).at(-1)?.startsWith("run-") === true) {
          return Array.from({ length: 2_000 }, (_value, index) => `${index}.${desired.fileName}.next`);
        }
        return nodeProjectAgentRuntime.readdir(path);
      },
    });

    await expect(syncProjectAgents(root, [desired], runtime)).rejects.toThrow(/recovery run has too many entries/iu);

    expect(await readFile(target)).toEqual(before);
  });

  it("stops before opening evidence that would exceed the per-run byte budget", async () => {
    const root = await initializedRoot(false);
    const recoveryRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
    const run = join(recoveryRoot, "run-000000000000000000000001");
    await mkdir(run, { recursive: true });
    for (let index = 0; index < 9; index += 1) {
      const path = join(run, `${index}.ezagent-budget-test.toml.next`);
      await writeFile(path, "", "utf8");
      await truncate(path, 1_048_576);
    }
    let evidenceOpens = 0;
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        if (path.startsWith(run)) evidenceOpens += 1;
        return nodeProjectAgentRuntime.open(path, flags, mode);
      },
    });

    await expect(syncProjectAgents(root, [], runtime)).rejects.toThrow(/per-run byte budget/iu);

    expect(evidenceOpens).toBe(8);
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
  });

  it("stops before opening evidence that would exceed the global byte budget", async () => {
    const root = await initializedRoot(false);
    const recoveryRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
    const runs: string[] = [];
    for (let runIndex = 0; runIndex < 5; runIndex += 1) {
      const run = join(recoveryRoot, `run-${String(runIndex + 1).padStart(24, "0")}`);
      runs.push(run);
      await mkdir(run, { recursive: true });
      const files = runIndex < 4 ? 8 : 1;
      for (let fileIndex = 0; fileIndex < files; fileIndex += 1) {
        const path = join(run, `${fileIndex}.ezagent-global-budget.toml.next`);
        await writeFile(path, "", "utf8");
        await truncate(path, 1_048_576);
      }
    }
    let evidenceOpens = 0;
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        if (runs.some((run) => path.startsWith(run))) evidenceOpens += 1;
        return nodeProjectAgentRuntime.open(path, flags, mode);
      },
    });

    await expect(syncProjectAgents(root, [], runtime)).rejects.toThrow(/global byte budget/iu);

    expect(evidenceOpens).toBe(32);
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
  });

  it("rejects a first large generated batch before creating recovery or Codex paths", async () => {
    const root = await initializedRoot(false);
    const desired = budgetRendered(9);
    await new ActiveExpertRepository(root).write({
      revision: 1,
      experts: desired.map((agent) => ({
        id: agent.expertId,
        reason: agent.assignment.reason,
        taskIds: agent.assignment.taskIds,
      })),
    }, 0);

    await expect(syncProjectAgents(root, desired)).rejects.toThrow(/planned recovery.*per-run byte budget/iu);

    await expectMissing(join(root, ".codex"));
    await expectMissing(join(root, ".ezagent", "backups", "generated-codex-agents"));
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
  });

  it("allows a near-budget first batch and its byte-identical zero-planned retry", async () => {
    const root = await initializedRoot(false);
    const desired = budgetRendered(8);
    await new ActiveExpertRepository(root).write({
      revision: 1,
      experts: desired.map((agent) => ({
        id: agent.expertId,
        reason: agent.assignment.reason,
        taskIds: agent.assignment.taskIds,
      })),
    }, 0);

    await syncProjectAgents(root, desired);
    const recoveryRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
    const runs = await readdir(recoveryRoot);
    await syncProjectAgents(root, desired);

    expect(await readdir(recoveryRoot)).toEqual(runs);
    expect((await readdir(join(root, ".codex", "agents"))).sort()).toEqual(
      desired.map((agent) => agent.fileName).sort(),
    );
  });

  it("rejects planned evidence against an already-full global budget before writes", async () => {
    const root = await initializedRoot(false);
    const recoveryRoot = join(root, ".ezagent", "backups", "generated-codex-agents");
    for (let runIndex = 0; runIndex < 4; runIndex += 1) {
      const run = join(recoveryRoot, `run-${String(runIndex + 1).padStart(24, "0")}`);
      await mkdir(run, { recursive: true });
      for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
        const path = join(run, `${fileIndex}.ezagent-existing-budget.toml.next`);
        await writeFile(path, "", "utf8");
        await truncate(path, 1_048_576);
      }
    }
    const desired = [rendered()];
    await new ActiveExpertRepository(root).write({
      revision: 1,
      experts: [{
        id: desired[0]!.expertId,
        reason: desired[0]!.assignment.reason,
        taskIds: desired[0]!.assignment.taskIds,
      }],
    }, 0);
    const beforeRuns = await readdir(recoveryRoot);

    await expect(syncProjectAgents(root, desired)).rejects.toThrow(/planned recovery.*global byte budget/iu);

    expect(await readdir(recoveryRoot)).toEqual(beforeRuns);
    await expectMissing(join(root, ".codex"));
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
  });

  it("rejects a planned first run when the recovery run-count limit is full", async () => {
    const root = await initializedRoot(false);
    const desired = [rendered()];
    await new ActiveExpertRepository(root).write({
      revision: 1,
      experts: [{
        id: desired[0]!.expertId,
        reason: desired[0]!.assignment.reason,
        taskIds: desired[0]!.assignment.taskIds,
      }],
    }, 0);
    const { runtime, recoveryRoot } = await virtualLimitRuntime(root, {
      runCount: 4_096,
      evidenceCount: 0,
      agentEntryCount: 0,
    });

    await expect(syncProjectAgents(root, desired, runtime))
      .rejects.toThrow(/planned recovery run count.*limit/iu);

    expect(await readdir(recoveryRoot)).toEqual([]);
    await expectMissing(join(root, ".codex"));
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
  });

  it("rejects planned files when the recovery evidence-entry limit is full", async () => {
    const root = await initializedRoot(false);
    const desired = [rendered()];
    await new ActiveExpertRepository(root).write({
      revision: 1,
      experts: [{
        id: desired[0]!.expertId,
        reason: desired[0]!.assignment.reason,
        taskIds: desired[0]!.assignment.taskIds,
      }],
    }, 0);
    const { runtime, recoveryRoot } = await virtualLimitRuntime(root, {
      runCount: 6,
      evidenceCount: 8_192,
      agentEntryCount: 0,
    });

    await expect(syncProjectAgents(root, desired, runtime))
      .rejects.toThrow(/planned recovery evidence entry count.*limit/iu);

    expect(await readdir(recoveryRoot)).toEqual([]);
    await expectMissing(join(root, ".codex"));
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
  }, 30_000);

  it("rejects a new target when the actual Codex agents entry limit is full", async () => {
    const root = await initializedRoot(false);
    const desired = [rendered()];
    await new ActiveExpertRepository(root).write({
      revision: 1,
      experts: [{
        id: desired[0]!.expertId,
        reason: desired[0]!.assignment.reason,
        taskIds: desired[0]!.assignment.taskIds,
      }],
    }, 0);
    const { runtime, recoveryRoot, agents } = await virtualLimitRuntime(root, {
      runCount: 0,
      evidenceCount: 0,
      agentEntryCount: 4_096,
    });

    await expect(syncProjectAgents(root, desired, runtime))
      .rejects.toThrow(/planned Codex agents entry count.*limit/iu);

    expect(await readdir(agents)).toEqual([]);
    expect(await readdir(recoveryRoot)).toEqual([]);
    await expectMissing(join(root, ".ezagent", "experts", "generated-codex.json"));
  });

  it("moves lexically-later stale ownership before publishing a new target at the directory limit", async () => {
    const root = await initializedRoot(false);
    const next = namedRendered("a");
    const stale = namedRendered("z");
    const agents = join(root, ".codex", "agents");
    const stalePath = join(agents, stale.fileName);
    const nextPath = join(agents, next.fileName);
    const manifestPath = join(root, ".ezagent", "experts", "generated-codex.json");
    await mkdir(agents, { recursive: true });
    await writeFile(stalePath, stale.content, "utf8");
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      files: { [stale.fileName]: stale.sha256 },
    }, null, 2)}\n`, "utf8");
    await new ActiveExpertRepository(root).write({
      revision: 1,
      experts: [{
        id: next.expertId,
        reason: next.assignment.reason,
        taskIds: next.assignment.taskIds,
      }],
    }, 0);
    const entries = new Set([
      stale.fileName,
      ...Array.from({ length: 4_095 }, (_value, index) => `user-${index}.toml`),
    ]);
    let peakEntries = entries.size;
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        const handle = await nodeProjectAgentRuntime.open(path, flags, mode);
        if (path === nextPath && flags === "wx") {
          entries.add(next.fileName);
          peakEntries = Math.max(peakEntries, entries.size);
        }
        return handle;
      },
      readdir: async (path) => (
        path === agents ? [...entries] : nodeProjectAgentRuntime.readdir(path)
      ),
      rename: async (oldPath, newPath) => {
        await nodeProjectAgentRuntime.rename(oldPath, newPath);
        if (oldPath === stalePath) entries.delete(stale.fileName);
      },
    });

    await expect(syncProjectAgents(root, [next], runtime)).resolves.toEqual({
      synced: true,
      files: [next.fileName],
    });

    expect(peakEntries).toBe(4_096);
    expect(entries.size).toBe(4_096);
    await expectMissing(stalePath);
    expect(await readFile(nextPath, "utf8")).toBe(next.content);
  });

  it("does not begin publication when any Phase A owned-target move fails", async () => {
    const root = await initializedRoot(false);
    const next = namedRendered("a");
    const stale = namedRendered("z");
    const agents = join(root, ".codex", "agents");
    const stalePath = join(agents, stale.fileName);
    const nextPath = join(agents, next.fileName);
    const manifestPath = join(root, ".ezagent", "experts", "generated-codex.json");
    await mkdir(agents, { recursive: true });
    await writeFile(stalePath, stale.content, "utf8");
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      files: { [stale.fileName]: stale.sha256 },
    }, null, 2)}\n`, "utf8");
    await new ActiveExpertRepository(root).write({
      revision: 1,
      experts: [{
        id: next.expertId,
        reason: next.assignment.reason,
        taskIds: next.assignment.taskIds,
      }],
    }, 0);
    const moveFailure = Object.assign(new Error("injected Phase A move failure"), { code: "EIO" });
    const runtime = injectedRuntime({
      rename: async (oldPath, newPath) => {
        if (oldPath === stalePath) throw moveFailure;
        await nodeProjectAgentRuntime.rename(oldPath, newPath);
      },
    });

    await expect(syncProjectAgents(root, [next], runtime))
      .rejects.toMatchObject({ code: "INSPECTION_REQUIRED" });

    expect(await readFile(stalePath, "utf8")).toBe(stale.content);
    await expectMissing(nextPath);
    expect(await readFile(manifestPath, "utf8")).toContain(stale.fileName);
  });

  it("allows a zero-planned no-op at every recovery and agent entry-count limit", async () => {
    const root = await initializedRoot(false);
    const manifestPath = join(root, ".ezagent", "experts", "generated-codex.json");
    const manifestBytes = `${JSON.stringify({ schemaVersion: 1, files: {} }, null, 2)}\n`;
    await writeFile(manifestPath, manifestBytes, "utf8");
    const { runtime, recoveryRoot, agents } = await virtualLimitRuntime(root, {
      runCount: 4_096,
      evidenceCount: 8_192,
      agentEntryCount: 4_096,
    });

    await expect(syncProjectAgents(root, [], runtime)).resolves.toEqual({
      synced: true,
      files: [],
    });

    expect(await readdir(recoveryRoot)).toEqual([]);
    expect(await readdir(agents)).toEqual([]);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBytes);
  }, 30_000);

  it("rejects actual on-disk portable case-fold collisions before managed writes", async () => {
    const root = await initializedRoot();
    const directory = join(root, ".codex", "agents");
    await mkdir(directory, { recursive: true });
    const uppercase = rendered().fileName.toUpperCase();
    await writeFile(join(directory, uppercase), "user uppercase bytes\n", "utf8");

    await expect(syncProjectAgents(root, [rendered()])).rejects.toThrow(/case-fold collision/iu);

    expect(await readFile(join(directory, uppercase), "utf8")).toBe("user uppercase bytes\n");
    await expectMissing(join(root, ".ezagent", "backups", "generated-codex-agents"));
  });

  it("is byte-identical on retry and leaves no adjacent temporary files", async () => {
    const root = await initializedRoot();
    await syncProjectAgents(root, [rendered()]);
    const agentPath = join(root, ".codex", "agents", rendered().fileName);
    const manifestPath = join(root, ".ezagent", "experts", "generated-codex.json");
    const beforeAgent = await readFile(agentPath);
    const beforeManifest = await readFile(manifestPath);
    const beforeRecovery = await readdir(join(root, ".ezagent", "backups", "generated-codex-agents"));

    await syncProjectAgents(root, [rendered()]);

    expect(await readFile(agentPath)).toEqual(beforeAgent);
    expect(await readFile(manifestPath)).toEqual(beforeManifest);
    expect(await readdir(join(root, ".ezagent", "backups", "generated-codex-agents")))
      .toEqual(beforeRecovery);
    expect((await readdir(join(root, ".codex", "agents"))).filter((name) => /\.next|\.tmp/u.test(name)))
      .toEqual([]);
  });
});
