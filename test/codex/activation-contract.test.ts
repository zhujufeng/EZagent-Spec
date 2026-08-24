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
  | "light-cosmetic"
  | "consult-no-work"
  | "uninitialized-no-workflow"
  | "explicit-initialize"
  | "high-risk";

describe("Codex activation policy contract", () => {
  test("declares realistic cases for later independent forward evaluation", async () => {
    const suite = await loadHostEvalSuite(HOST_EVAL_SUITE);
    const policies = new Set([
      "consult-no-work",
      "no-workflow",
      "initialize",
      "router-light",
      "router-standard",
      "router-high",
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
        body: spec.body,
        pattern: /Excel 导出.*不涉及.*权限.*安全.*敏感.*破坏性数据.*生产环境.*不可逆.*新增能力.*standard/su,
      },
      "light-cosmetic": {
        body: spec.body,
        pattern: /纯文案.*颜色.*局部样式.*不改.*行为.*接口.*数据.*依赖.*安全.*light/su,
      },
      "consult-no-work": {
        body: router.body,
        pattern: /解释.*只读咨询.*consult.*不创建工作项/su,
      },
      "uninitialized-no-workflow": {
        body: router.body,
        pattern: /未找到.*普通开发请求.*不进入.*明确要求.*启用/su,
      },
      "explicit-initialize": {
        body: initialize.description,
        pattern: /明确要求.*启用.*初始化.*安装/u,
      },
      "high-risk": {
        body: spec.body,
        pattern: /权限.*安全边界.*敏感.*破坏性数据.*生产环境.*不可逆.*high/su,
      },
    };

    expect(router.description).toMatch(/开发|修改|修复|重构|实现|审查|验证/u);
    for (const fixture of suite.cases) {
      const anchor = anchoredBodies[fixture.ruleAnchor];
      expect(anchor.body, fixture.name).toMatch(anchor.pattern);
    }
    expect(spec.body).toMatch(/不确定.*standard/u);
  });

  test("statically links AGENTS to Router and the workflow Skills", async () => {
    const agentsBlock = mergeEzagentAgentsBlock("");
    const router = await readSkill("ezagent-router");
    const initialize = await readSkill("ezagent-initialize");

    expect(agentsBlock).toContain("$ezagent-router");
    expect(router.description).toMatch(/开发|修改|修复|重构|实现|审查|验证/u);
    expect(router.body).toContain('"<absolute-cli-path>"');
    expect(router.body).toContain('"context"');
    expect(router.body).toContain(".ezagent/project.yaml");
    expect(router.body).toContain("$ezagent-light");
    expect(router.body).toContain("$ezagent-spec");
    expect(router.body).toContain("$ezagent-implement");
    expect(router.body).toContain("$ezagent-review");
    expect(initialize.body).toContain("integration-preview");
    expect(initialize.body).toContain("integration-init");
    expect(initialize.body).toContain("用户明确同意");
    expect(agentsBlock).toContain("先恢复并核对已批准专家团队");
  });

  test("routes bounded light work without creating the standard persisted workflow", async () => {
    const router = await readSkill("ezagent-router");
    const light = await readSkill("ezagent-light");

    expect(router.body).toMatch(/light.*\$ezagent-light/su);
    expect(router.body).toMatch(/依赖.*数据模型.*迁移.*鉴权.*安全边界.*部署基础设施.*公共 API.*跨模块架构.*standard/su);
    expect(light.description).toMatch(/低风险.*局部.*可逆/u);
    expect(light.body).toMatch(/最多 5 项/u);
    expect(light.body).toMatch(/不.*再次.*批准/u);
    expect(light.body).toMatch(/不得.*\.ezagent\/\*\*/u);
    expect(light.body).toMatch(/不调用.*team-select-preview.*plan-preview.*plan-apply.*transition/su);
    expect(light.body).toMatch(/不得.*虚构.*结果/u);
    expect(light.body).toMatch(/范围扩大.*停止.*写入.*standard/su);
  });

  test("routes shared context and approved team knowledge through the dedicated Skill", async () => {
    const router = await readSkill("ezagent-router");
    const context = await readSkill("ezagent-context");

    expect(router.body).toMatch(/启用团队共享.*更新项目上下文.*团队经验.*\$ezagent-context/su);
    expect(router.body).toMatch(/Task 标题.*目标.*capabilities.*domains.*projectSignals.*knowledge-context/su);
    expect(context.body).toMatch(/预览.*用户.*批准.*Apply/su);
    expect(context.body).toMatch(/只请求一次批准/u);
    expect(context.body).toMatch(/不执行.*Git/u);
  });

  test("declares the automatic expert-team command order", async () => {
    const router = await readSkill("ezagent-router");
    const context = router.body.indexOf("context");
    const structured = router.body.indexOf("结构化 Plan");
    const select = router.body.indexOf("team-select-preview");
    const preview = router.body.indexOf("plan-preview");
    const apply = router.body.indexOf("plan-apply");
    const reconcile = router.body.indexOf("experts-reconcile");
    const implementing = router.body.lastIndexOf("implementing");

    expect(context).toBeGreaterThanOrEqual(0);
    expect(structured).toBeGreaterThan(context);
    expect(select).toBeGreaterThan(structured);
    expect(preview).toBeGreaterThan(select);
    expect(apply).toBeGreaterThan(preview);
    expect(reconcile).toBeGreaterThan(apply);
    expect(implementing).toBeGreaterThan(reconcile);
  });

  test("defaults uncertain behavior changes to standard and fails closed in safe mode", async () => {
    const router = await readSkill("ezagent-router");

    expect(router.body).toMatch(/consult.*light.*standard.*high/su);
    expect(router.body).toMatch(/不确定.*行为变更.*standard/u);
    expect(router.body).toMatch(/必要.*澄清/u);
    expect(router.body).toMatch(/安全模式.*只.*诊断/u);
    expect(router.body).toMatch(/所有状态变化.*本地核心.*验证/u);
  });
});
