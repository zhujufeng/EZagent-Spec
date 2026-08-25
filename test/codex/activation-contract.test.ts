import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, test } from "vitest";

import { mergeEzagentAgentsBlock } from "../../src/adapters/codex/agents-md.js";
import { loadHostEvalSuite } from "../../scripts/codex-host-eval.js";

const SKILLS_ROOT = fileURLToPath(
  new URL("../../plugins/ezagent-spec/skills/", import.meta.url),
);
const HOST_EVAL_SUITE = fileURLToPath(
  new URL("../fixtures/codex-host-eval.json", import.meta.url),
);

interface SkillDocument {
  readonly description: string;
  readonly body: string;
}

async function readSkill(name: string): Promise<SkillDocument> {
  const contents = await readFile(`${SKILLS_ROOT}${name}/SKILL.md`, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(contents);
  expect(match).not.toBeNull();
  const frontmatter = parse(match![1]!) as Record<string, unknown>;
  return { description: String(frontmatter.description), body: match![2]! };
}

type RuleAnchor =
  | "standard-new-capability"
  | "quick-cosmetic"
  | "brief-analysis"
  | "consult-no-work"
  | "uninitialized-no-workflow"
  | "explicit-initialize"
  | "controlled-side-effect";

describe("Codex activation policy contract", () => {
  test("declares realistic cases for later independent forward evaluation", async () => {
    const suite = await loadHostEvalSuite(HOST_EVAL_SUITE);
    const policies = new Set([
      "consult-no-work",
      "no-workflow",
      "initialize",
      "router-quick",
      "router-brief",
      "router-standard",
      "router-controlled",
    ]);

    expect(new Set(suite.cases.map(({ name }) => name)).size).toBe(
      suite.cases.length,
    );
    for (const fixture of suite.cases) {
      expect(fixture.prompt.trim(), fixture.name).not.toBe("");
      expect(fixture.initialized, fixture.name).toBeTypeOf("boolean");
      expect(policies.has(fixture.expectedPolicy), fixture.name).toBe(true);
    }
    expect(new Set(suite.cases.map(({ expectedPolicy }) => expectedPolicy))).toEqual(
      policies,
    );
  });

  test("declares static activation policy anchors without simulating model discovery", async () => {
    const suite = await loadHostEvalSuite(HOST_EVAL_SUITE);
    const router = await readSkill("ezagent-router");
    const initialize = await readSkill("ezagent-initialize");
    const spec = await readSkill("ezagent-spec");

    const anchoredBodies: Record<RuleAnchor, { readonly body: string; readonly pattern: RegExp }> = {
      "standard-new-capability": {
        body: router.body,
        pattern: /Standard.*多来源.*多交付物.*依赖 Slice.*中等影响/su,
      },
      "quick-cosmetic": {
        body: router.body,
        pattern: /Quick.*目标清楚.*局部.*低影响.*可逆.*单会话/su,
      },
      "brief-analysis": {
        body: router.body,
        pattern: /Brief.*1–5 个.*可验证 Slices.*跨会话恢复/su,
      },
      "consult-no-work": {
        body: router.body,
        pattern: /Consult.*解释.*只读咨询.*不持久化/su,
      },
      "uninitialized-no-workflow": {
        body: router.body,
        pattern: /未找到.*普通请求.*不触发.*明确要求.*启用/su,
      },
      "explicit-initialize": {
        body: initialize.description,
        pattern: /明确要求.*启用.*初始化.*安装/u,
      },
      "controlled-side-effect": {
        body: router.body,
        pattern: /Controlled.*敏感信息.*对外沟通.*发布.*预算.*生产系统.*难回滚.*Side Effect.*单独批准/su,
      },
    };

    expect(router.description).toMatch(/编码.*分析.*文档.*策划.*其他 Agent 工作/u);
    for (const fixture of suite.cases) {
      const anchor = anchoredBodies[fixture.ruleAnchor];
      expect(anchor.body, fixture.name).toMatch(anchor.pattern);
    }
    expect(router.body).toMatch(/不确定.*一个会改变结果的问题/u);
  });

  test("statically links AGENTS to Router and the workflow Skills", async () => {
    const agentsBlock = mergeEzagentAgentsBlock("");
    const router = await readSkill("ezagent-router");
    const initialize = await readSkill("ezagent-initialize");

    expect(agentsBlock).toContain("$ezagent-router");
    expect(router.description).toMatch(/编码.*分析.*文档.*策划/u);
    expect(router.body).toContain('"<absolute-cli-path>"');
    expect(router.body).toContain('"context"');
    expect(router.body).toContain(".ezagent/project.yaml");
    expect(router.body).toContain("$ezagent-light");
    expect(router.body).toContain("$ezagent-spec");
    expect(router.body).toContain("$ezagent-execute");
    expect(router.body).toContain("$ezagent-implement");
    expect(router.body).toContain("$ezagent-review");
    expect(initialize.body).toContain("integration-preview");
    expect(initialize.body).toContain("integration-init");
    expect(initialize.body).toContain("用户明确同意");
    expect(agentsBlock).toContain("Specialist 与多 Agent 不是默认前置");
    expect(agentsBlock).toContain("Specialist Assessment");
    expect(agentsBlock).toMatch(/project Agent.*协调器.*(?:模拟|替换)/u);
  });

  test("hands unfinished same-run work from initialization to the Router", async () => {
    const agentsBlock = mergeEzagentAgentsBlock("");
    const initialize = await readSkill("ezagent-initialize");
    const router = await readSkill("ezagent-router");
    const spec = await readSkill("ezagent-spec");

    expect(initialize.body).toMatch(/初始化成功后.*原始请求.*剩余目标/su);
    expect(initialize.body).toMatch(/有剩余目标.*显式.*\$ezagent-router/su);
    expect(initialize.body).toMatch(/不得.*恢复.*初始化前.*主工作流/su);
    expect(initialize.body).toMatch(/初始化.*批准.*不.*Work Contract.*批准/su);
    expect(initialize.body).toMatch(/宿主.*无法.*Router.*新任务/su);
    expect(router.body).toMatch(/context.*准备.*不.*完成.*路由/su);
    expect(router.body).toMatch(/模式.*理由.*下一个 Skill.*实际转交/su);
    expect(spec.body).toMatch(/Router.*同一任务.*context.*复用.*不得重复/su);
    expect(agentsBlock).toMatch(/Router.*顶层工作流/su);
    expect(agentsBlock).toMatch(/context.*不.*完成.*路由/su);
  });

  test("routes bounded Quick work without creating a persisted workflow", async () => {
    const router = await readSkill("ezagent-router");
    const light = await readSkill("ezagent-light");

    expect(router.body).toMatch(/Quick.*\$ezagent-light/su);
    expect(light.description).toMatch(/低风险.*局部.*可逆/u);
    expect(light.body).toMatch(/最多 5 项/u);
    expect(light.body).toMatch(/不.*再次.*批准/u);
    expect(light.body).toMatch(/不得.*\.ezagent\/\*\*/u);
    expect(light.body).toMatch(/不调用.*team-select-preview.*plan-preview.*plan-apply.*transition/su);
    expect(light.body).toMatch(/不得.*虚构.*结果/u);
    expect(light.body).toMatch(/范围扩大.*停止.*写入.*Standard/su);
  });

  test("routes shared context and approved team knowledge through the dedicated Skill", async () => {
    const router = await readSkill("ezagent-router");
    const context = await readSkill("ezagent-context");

    expect(router.body).toMatch(/共享项目上下文.*晋升 Pattern.*\$ezagent-context/su);
    expect(router.body).toMatch(/outcome.*Canonical Terms.*边界.*knowledge-context/su);
    expect(context.body).toMatch(/预览.*用户.*批准.*Apply/su);
    expect(context.body).toMatch(/只请求一次批准/u);
    expect(context.body).toMatch(/不执行.*Git/u);
  });

  test("declares the v2 Work Contract and Slice command order", async () => {
    const spec = await readSkill("ezagent-spec");
    const execute = await readSkill("ezagent-execute");
    const shared = spec.body.indexOf("Shared Design Concept");
    const contract = spec.body.indexOf("通用 Work Contract");
    const preview = spec.body.indexOf("work-preview");
    const apply = spec.body.indexOf("work-apply");
    const start = execute.body.indexOf("work-start");
    const journal = execute.body.indexOf("journal-append");
    const review = execute.body.indexOf("work-review");

    expect(shared).toBeGreaterThanOrEqual(0);
    expect(contract).toBeGreaterThan(shared);
    expect(preview).toBeGreaterThan(contract);
    expect(apply).toBeGreaterThan(preview);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(journal).toBeGreaterThan(start);
    expect(review).toBeGreaterThan(journal);
    expect(spec.body).not.toContain("team-select-preview");
  });

  test("asks one consequential question when uncertain and fails closed in safe mode", async () => {
    const router = await readSkill("ezagent-router");

    expect(router.body).toMatch(/Consult.*Quick.*Brief.*Standard.*Controlled/su);
    expect(router.body).toMatch(/不确定.*一个会改变结果的问题.*推荐答案/u);
    expect(router.body).toMatch(/不要用一轮长问卷/u);
    expect(router.body).toMatch(/安全模式.*只.*诊断/u);
    expect(router.body).toMatch(/所有状态变化.*本地核心.*验证/u);
  });
});
