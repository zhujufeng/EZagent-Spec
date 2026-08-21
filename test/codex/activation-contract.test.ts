import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, test } from "vitest";

import { mergeEzagentAgentsBlock } from "../../src/adapters/codex/agents-md.js";

const SKILLS_ROOT = fileURLToPath(
  new URL("../../plugins/ezagent-spec/skills/", import.meta.url),
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

const FORWARD_TEST_CASES = [
  {
    name: "initialized Excel export is a behavior change",
    prompt: "给订单列表增加 Excel 导出",
    initialized: true,
    expectedPolicy: "router-standard",
    ruleAnchor: "standard-new-capability",
  },
  {
    name: "initialized cosmetic button change stays light",
    prompt: "把保存按钮换成品牌蓝，不改变交互",
    initialized: true,
    expectedPolicy: "router-light",
    ruleAnchor: "light-cosmetic",
  },
  {
    name: "architecture explanation stays consultative",
    prompt: "只解释一下当前架构为什么这样分层，不要修改代码",
    initialized: true,
    expectedPolicy: "consult-no-work",
    ruleAnchor: "consult-no-work",
  },
  {
    name: "ordinary development does not initialize a project",
    prompt: "帮我实现登录页",
    initialized: false,
    expectedPolicy: "no-workflow",
    ruleAnchor: "uninitialized-no-workflow",
  },
  {
    name: "unrelated initialization does not enable EZagent",
    prompt: "请初始化数据库连接池",
    initialized: false,
    expectedPolicy: "no-workflow",
    ruleAnchor: "uninitialized-no-workflow",
  },
  {
    name: "explicit EZagent enablement enters initialization",
    prompt: "请在当前项目启用 EZagent Spec",
    initialized: false,
    expectedPolicy: "initialize",
    ruleAnchor: "explicit-initialize",
  },
  {
    name: "production data migration is high risk",
    prompt: "迁移生产数据库并删除旧表，要求不可回滚",
    initialized: true,
    expectedPolicy: "router-high",
    ruleAnchor: "high-risk",
  },
] as const;

describe("Codex activation policy contract", () => {
  test("declares realistic cases for later independent forward evaluation", () => {
    const policies = new Set([
      "consult-no-work",
      "no-workflow",
      "initialize",
      "router-light",
      "router-standard",
      "router-high",
    ]);

    expect(new Set(FORWARD_TEST_CASES.map(({ name }) => name)).size).toBe(
      FORWARD_TEST_CASES.length,
    );
    for (const fixture of FORWARD_TEST_CASES) {
      expect(fixture.prompt.trim(), fixture.name).not.toBe("");
      expect(fixture.initialized, fixture.name).toBeTypeOf("boolean");
      expect(policies.has(fixture.expectedPolicy), fixture.name).toBe(true);
    }
    expect(new Set(FORWARD_TEST_CASES.map(({ expectedPolicy }) => expectedPolicy))).toEqual(
      policies,
    );
  });

  test("declares static activation policy anchors without simulating model discovery", async () => {
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
    for (const fixture of FORWARD_TEST_CASES) {
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
    expect(router.body).toContain("$ezagent-spec");
    expect(router.body).toContain("$ezagent-implement");
    expect(router.body).toContain("$ezagent-review");
    expect(initialize.body).toContain("integration-preview");
    expect(initialize.body).toContain("integration-init");
    expect(initialize.body).toContain("用户明确同意");
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
