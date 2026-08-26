import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, test } from "vitest";

const SKILLS_ROOT = fileURLToPath(
  new URL("../../plugins/ezagent-spec/skills/", import.meta.url),
);
const EXPECTED_SKILLS = [
  "ezagent-router",
  "ezagent-initialize",
  "ezagent-light",
  "ezagent-context",
  "ezagent-spec",
  "ezagent-execute",
  "ezagent-implement",
  "ezagent-review",
] as const;
const TRANSITION_SKILLS = [
  "ezagent-implement",
  "ezagent-review",
] as const;
const CANCELLATION_SKILLS = [
  "ezagent-router",
  "ezagent-spec",
  "ezagent-execute",
  "ezagent-implement",
  "ezagent-review",
] as const;
const JSON_INPUT_SKILLS = [
  "ezagent-router",
  "ezagent-context",
  "ezagent-spec",
  "ezagent-execute",
  "ezagent-review",
] as const;
const PLUGIN_ROOT_INSTRUCTION =
  "先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`";

interface SkillDocument {
  readonly directory: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

type JsonObject = Record<string, unknown>;

async function readSkill(directory: string): Promise<SkillDocument> {
  const path = `${SKILLS_ROOT}${directory}/SKILL.md`;
  const contents = await readFile(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(contents);
  expect(match, `${path} must contain YAML frontmatter`).not.toBeNull();
  return {
    directory,
    frontmatter: parse(match![1]!) as Record<string, unknown>,
    body: match![2]!,
  };
}

function jsonBlocks(skill: SkillDocument): unknown[] {
  return [...skill.body.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/gu)].map((match) =>
    JSON.parse(match[1]!) as unknown,
  );
}

function argvExamples(skill: SkillDocument): string[][] {
  return jsonBlocks(skill).filter(
    (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string"),
  );
}

function structuredContract(skill: SkillDocument, key: string): JsonObject {
  const block = jsonBlocks(skill).find(
    (value) =>
      typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && Object.hasOwn(value, key),
  );
  expect(block, `${skill.directory} must declare ${key}`).toBeDefined();
  return (block as JsonObject)[key] as JsonObject;
}

function argvFor(skill: SkillDocument, command: string): string[] {
  const argv = argvExamples(skill).find((example) => example.includes(command));
  expect(argv, `${skill.directory} must declare argv for ${command}`).toBeDefined();
  return argv!;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

describe("Codex Skill contracts", () => {
  test("ships exactly the eight concise, implicitly discoverable workflow Skills", async () => {
    const directories = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual([...EXPECTED_SKILLS].sort());

    const skills = await Promise.all(EXPECTED_SKILLS.map(readSkill));
    const names = skills.map(({ frontmatter }) => frontmatter.name);
    expect(new Set(names).size).toBe(skills.length);

    for (const skill of skills) {
      expect(skill.frontmatter.name).toBe(skill.directory);
      expect(skill.frontmatter.description).toEqual(expect.any(String));
      expect((skill.frontmatter.description as string).trim()).not.toBe("");
      expect(skill.frontmatter["disable-model-invocation"] ?? false).toBe(false);
      expect(skill.frontmatter.policy).not.toMatchObject({ allow_implicit_invocation: false });
      expect(Object.keys(skill.frontmatter).sort()).toEqual(["description", "name"]);
    }
  });

  test("resolves the packaged CLI into shell-free argv without Hook, PATH, or invented command contracts", async () => {
    const skills = await Promise.all(EXPECTED_SKILLS.map(readSkill));
    const forbidden = [
      /CLAUDE_PLUGIN_ROOT/u,
      /CODEX_PLUGIN_ROOT/u,
      /UserPromptSubmit/u,
      /SessionStart/u,
      /PreToolUse/u,
      /\bHooks?\b/u,
      /\bwhich\s+ezagent\b/u,
      /\bwhere\s+ezagent\b/u,
      /\bcommand\s+-v\s+ezagent\b/u,
      /ezagent-cli\.mjs\s+(?:requirement|spec|task|knowledge)-[a-z-]+/u,
    ];

    for (const skill of skills) {
      expect(skill.body).toContain(PLUGIN_ROOT_INSTRUCTION);
      expect(skill.body).not.toMatch(/(?:SKILL\.md`?\s*(?:绝对)?路径|本 Skill 的 `SKILL\.md`).*向上两级/u);
      expect(skill.body).toMatch(/支持 argv 数组.*禁止.*shell 字符串/su);
      expect(skill.body).toMatch(/每个动态值.*独立.*argv 元素/u);
      expect(skill.body).toMatch(/当前 shell.*literal.*无法证明.*关闭失败/su);
      expect(skill.body).toMatch(/不得.*仅.*双引号/u);
      expect(skill.body).toMatch(/绝对路径/u);
      expect(skill.body).toMatch(/不(?:得|要).*PATH/u);
      expect(skill.body).toMatch(/不(?:得|要).*用户.*(?:输入|敲|运行).*CLI/u);
      const examples = argvExamples(skill);
      expect(examples.length, `${skill.directory} must include argv examples`).toBeGreaterThan(0);
      expect(examples.some((argv) => argv[0] === "node" && argv[1] === "<absolute-cli-path>")).toBe(true);
      for (const argv of examples) {
        for (const element of argv) {
          if (element.includes("<") || element.includes(">")) {
            expect(element).toMatch(/^<[^<>]+>$/u);
          }
        }
      }
      const withoutJsonArrays = skill.body.replace(/```json\r?\n\[[\s\S]*?\]\r?\n```/gu, "");
      expect(withoutJsonArrays).not.toMatch(/(?:node|sh|bash|zsh|powershell|pwsh|cmd)\s+[^\n]*<[^>]+>/iu);
      expect(skill.body).not.toMatch(/```(?:sh|bash|zsh|powershell|cmd)\b/iu);
      for (const pattern of forbidden) expect(skill.body).not.toMatch(pattern);
    }
  });

  test("keeps hostile project roots and names as single argv elements", async () => {
    const initialize = await readSkill("ezagent-initialize");
    const template = argvFor(initialize, "integration-init");
    const hostileRoot = "/tmp/project/$(touch pwned)`echo bad`\"'&%VAR%\nnext";
    const hostileName = "Demo $(id)`whoami`\"'&%PATH%\nname";
    const replacements: Readonly<Record<string, string>> = {
      "<absolute-cli-path>": "/opt/EZagent Spec/dist/ezagent-cli.mjs",
      "<absolute-project-root>": hostileRoot,
      "<project-name>": hostileName,
      "<agents-token>": "sha256:safe-token",
    };
    const argv = template.map((element) => replacements[element] ?? element);

    expect(argv).toHaveLength(template.length);
    expect(option(argv, "--root")).toBe(hostileRoot);
    expect(option(argv, "--name")).toBe(hostileName);
    expect(argv[0]).toBe("node");
    expect(argv[1]).toBe(replacements["<absolute-cli-path>"]);
    const shellExecutables = new Set(["sh", "bash", "zsh", "cmd", "powershell", "pwsh"]);
    expect(shellExecutables.has(argv[0]!.toLowerCase())).toBe(false);
    const lowerArgv = argv.map((element) => element.toLowerCase());
    for (const shellMode of ["-c", "/c", "-command"]) {
      expect(lowerArgv).not.toContain(shellMode);
    }
  });

  test("uses the bounded input-file channel when a host PTY cannot close stdin", async () => {
    const skills = await Promise.all(JSON_INPUT_SKILLS.map(readSkill));

    for (const skill of skills) {
      expect(skill.body).toContain("--input-file");
      expect(skill.body).toMatch(/PTY.*stdin.*EOF|stdin.*EOF.*PTY/su);
      expect(skill.body).toMatch(/临时.*普通文件.*符号链接/su);
      expect(skill.body).toMatch(/操作系统临时目录.*项目根目录之外/su);
      expect(skill.body).toMatch(/预览.*Apply.*完全相同.*文件/su);
      expect(skill.body).toMatch(/不得.*shell.*重定向/u);
    }
  });

  test("takes transition revisions only from the latest active work item context", async () => {
    const skills = await Promise.all(TRANSITION_SKILLS.map(readSkill));

    for (const skill of skills) {
      expect(skill.body).toMatch(/每次 `transition` 前.*重新执行 `context`/u);
      expect(skill.body).toMatch(/`state\.activeWorkItem`.*为空.*不得.*transition/u);
      expect(skill.body).toContain(
        "最近一次 `context` JSON 的 `state.activeWorkItem.revision`",
      );
      expect(skill.body).toContain("绝不得使用 `state.revision`");
    }
  });

  test("exposes an explicit abandonment exit from every active Work Item workflow", async () => {
    const skills = await Promise.all(CANCELLATION_SKILLS.map(readSkill));

    for (const skill of skills) {
      const cancellation = argvFor(skill, "work-cancel");
      expect(option(cancellation, "--root")).toBe("<absolute-project-root>");
      expect(option(cancellation, "--revision")).toBe("<active-work-item-revision>");
      expect(skill.body).toMatch(/用户.*明确.*(?:取消|放弃)/u);
      expect(skill.body).toMatch(/取消.*重新执行 `context`/su);
      expect(skill.body).toMatch(/active.*(?:为空|null)/su);
    }
  });

  test("fails closed for every high-risk implementation in this release", async () => {
    const implement = await readSkill("ezagent-implement");

    expect(argvExamples(implement).some((argv) => argv.includes("--high-risk-authorization"))).toBe(false);
    expect(implement.body).not.toContain("AUTH-");
    expect(implement.body).toMatch(/当前版本.*不支持.*高风险.*实施/su);
    expect(implement.body).toMatch(/risk.*high.*停止.*不得.*implementing/su);
  });

  test("closes the review failure loop through the supported verifying-to-implementing transition", async () => {
    const review = await readSkill("ezagent-review");
    const implement = await readSkill("ezagent-implement");
    const reviewGuard = structuredContract(review, "stateGuard");
    const implementGuard = structuredContract(implement, "stateGuard");
    const failureHandoff = structuredContract(review, "failureHandoff");
    const retry = argvFor(review, "transition");

    expect(reviewGuard).toEqual({ kind: "task", statuses: ["verifying"] });
    expect(implementGuard).toEqual({ kind: "task", statuses: ["planned", "implementing"] });
    expect(failureHandoff).toEqual({
      fromStatus: "verifying",
      toStatus: "implementing",
      supportedRisks: ["light", "standard"],
      highRisk: "fail-closed",
      targetSkill: "ezagent-implement",
      onTransitionFailure: "fail-closed",
    });
    expect(option(retry, "--to")).toBe("implementing");
    expect(option(retry, "--revision")).toBe("<active-work-item-revision>");
    expect(review.body).toMatch(/high.*返工.*关闭失败/su);
    expect(review.body).toMatch(/transition.*失败.*关闭失败.*不得.*Implement/su);
    expect(review.body).toContain("$ezagent-implement");
    expect(implement.body).toMatch(/status.*planned.*implementing/su);
    expect(implement.body).toMatch(/implementing.*继续/u);
  });

  test("routes new work through the general harness and retains v1 coding compatibility", async () => {
    const router = await readSkill("ezagent-router");
    const spec = await readSkill("ezagent-spec");
    const execute = await readSkill("ezagent-execute");
    const implement = await readSkill("ezagent-implement");
    const review = await readSkill("ezagent-review");

    expect(router.body).toMatch(/Consult.*Quick.*Brief.*Standard.*Controlled/su);
    expect(router.body).toMatch(/编码、分析、文档、策划.*其他/u);
    expect(router.body).toContain("$ezagent-execute");
    expect(spec.body).toContain("work-preview");
    expect(spec.body).toContain("work-apply");
    expect(spec.body).not.toContain("team-select-preview");
    expect(execute.body).toContain("work-start");
    expect(execute.body).toContain("journal-append");
    expect(execute.body).toContain("work-review");
    expect(review.body).toContain("work-complete");
    expect(implement.body).toMatch(/v1.*兼容/su);
    expect(implement.body).toContain("platformSyncStatus");
    expect(implement.body).toContain("ready");
    expect(implement.body).toContain("replan-preview");
    expect(review.body).toMatch(/v1.*旧编码.*适配/su);
  });

  test("keeps personnel open-ended and specialists optional", async () => {
    const router = await readSkill("ezagent-router");
    const spec = await readSkill("ezagent-spec");
    const execute = await readSkill("ezagent-execute");

    expect(spec.body).toMatch(/不得成为固定角色枚举/u);
    expect(spec.body).toMatch(/只能作为非穷尽示例/u);
    expect(spec.body).toMatch(/Specialist.*多 Agent.*可选/su);
    expect(router.body).toMatch(/不得固定人员、数量或岗位/u);
    expect(execute.body).toMatch(/人员和数量不固定/u);
    for (const skill of [router, spec, execute]) {
      expect(skill.body).not.toMatch(/(?:只能|必须由).*(?:库存|运营|策划|人事|HR|研发)/iu);
    }
  });

  test("requires an explicit Specialist assessment without preselecting experts", async () => {
    const router = await readSkill("ezagent-router");
    const spec = await readSkill("ezagent-spec");
    const shared = spec.body.indexOf("Shared Design Concept");
    const assessment = spec.body.indexOf("specialistAssessment");
    const preview = spec.body.indexOf("work-preview");

    expect(router.body).toMatch(/Shared Design Concept.*Specialist Assessment/su);
    expect(router.body).toMatch(/not-needed.*Capability Needs/su);
    expect(router.body).toMatch(/资金.*领域风险.*本身.*不得.*Controlled/su);
    expect(router.body).toMatch(/仅.*分析.*规划.*不包含.*生产.*外部.*Standard/su);
    expect(router.body).toMatch(/实现.*未参与实现.*独立 Agent 审查.*至少.*Standard/su);
    expect(router.body).toMatch(/询问.*角色.*开始分析.*行为.*数据契约.*至少.*Standard/su);
    expect(router.body).toMatch(/至少一个.*implementation.*Capability Need/su);
    expect(assessment).toBeGreaterThan(shared);
    expect(preview).toBeGreaterThan(assessment);
    expect(spec.body).toMatch(/specialistAssessment.*每次.*必须.*显式/su);
    expect(spec.body).toMatch(/decision: not-needed.*空 `needs`/su);
    expect(spec.body).toMatch(/最小必要.*1–3 个 Slice.*1–3 个 Deliverable.*3–6 条 Acceptance Criteria/su);
    expect(spec.body).toMatch(/同一 Slice.*相同.*purpose.*合并.*Capability Need/su);
    expect(spec.body).toMatch(/decision: required.*`sliceId`.*`purpose`.*`capabilities`.*`isolationReason`/su);
    expect(spec.body).toMatch(/Assessment 不得填写 expert ID、指定人数/u);
    expect(spec.body).toMatch(/delegations、未覆盖能力与 blockers/u);
    expect(spec.body).toMatch(/批准前.*尚未.*实际委派.*尚未.*独立审查/su);
    expect(spec.body).toMatch(/不得声称.*已完成审查/u);
    expect(spec.body).toMatch(/批准后.*dispatch.*Work Item ID.*Evidence requirements.*有界.*摘要/su);
    expect(spec.body).toMatch(/Specialist Assessment.*required.*最终答复.*委派边界.*不得省略/su);
    expect(spec.body).toMatch(/匹配的隔离 project Agent.*协调器.*不得.*模拟/su);
    expect(spec.body).toMatch(/不得.*读取、搜索或枚举.*catalog\/experts\.json/su);
    expect(spec.body).toMatch(/不得.*二次猜测.*Core.*确定性匹配/su);
    expect(spec.body).toMatch(/uncoveredCapabilities.*blockers.*最多.*一次/su);
    expect(spec.body).toMatch(/Codex.*不得.*printf.*shell 管道.*--input-file/su);
  });

  test("binds controlled side effects to an exact approval without pretending to execute them", async () => {
    const spec = await readSkill("ezagent-spec");
    const execute = await readSkill("ezagent-execute");

    expect(spec.body).toMatch(/Controlled.*批准不等于.*Side Effect.*授权/su);
    expect(argvFor(execute, "side-effect-preview")).toBeDefined();
    expect(argvFor(execute, "side-effect-apply")).toBeDefined();
    expect(execute.body).toMatch(/action、target.*content hash/su);
    expect(execute.body).toContain("externalActionExecuted: false");
    expect(execute.body).toMatch(/Apply 只生成.*授权记录.*不会执行外部动作/u);
    expect(execute.body).toMatch(/漂移.*重新预览和批准/u);
  });

  test("retrieves summaries and gates sharing or Pattern promotion behind one approval", async () => {
    const context = await readSkill("ezagent-context");
    const router = await readSkill("ezagent-router");

    for (const command of [
      "knowledge-context",
      "sharing-preview",
      "sharing-apply",
      "knowledge-promote-preview",
      "knowledge-promote-apply",
    ]) {
      expect(argvFor(context, command)).toBeDefined();
    }
    expect(String(context.frontmatter.description)).toMatch(/共享.*上下文|知识.*Pattern/u);
    expect(context.body).toMatch(/短.*terms.*stdin/su);
    expect(context.body).toMatch(/最多 5 条.*摘要/u);
    expect(context.body).toMatch(/sharing-preview.*用户.*批准.*sharing-apply/su);
    expect(context.body).toMatch(/knowledge-promote-preview.*用户.*批准.*knowledge-promote-apply/su);
    expect(context.body).toMatch(/只.*一次.*批准/u);
    expect(context.body).toMatch(/不.*完整用户提示.*聊天/u);
    expect(router.body).toContain("$ezagent-context");
    expect(router.body).toContain("knowledge-context");
    expect(router.body).toMatch(/短.*terms.*最多 5 条.*摘要/su);
    expect(router.body).toMatch(/不.*复制.*评分/u);
  });

  test("detects the OS with cross-platform built-ins before checking Node separately", async () => {
    const initialize = await readSkill("ezagent-initialize");
    const examples = argvExamples(initialize);

    expect(examples).toContainEqual(["uname", "-s"]);
    expect(examples).toContainEqual(["cmd", "/c", "ver"]);
    expect(examples).toContainEqual(["node", "--version"]);
    expect(initialize.body).toMatch(/操作系统.*之后.*单独.*Node/su);
  });

  test("uses confirmed workspace-root metadata instead of cwd during initialization", async () => {
    const initialize = await readSkill("ezagent-initialize");
    const selection = structuredContract(initialize, "projectRootSelection");
    const integrationInit = argvFor(initialize, "integration-init");

    expect(selection).toEqual({
      source: "host-workspace-root",
      ambiguous: "show-absolute-candidates-and-confirm",
      cwdOnly: false,
      projectNameSource: "confirmed-selection",
    });
    expect(option(integrationInit, "--root")).toBe("<absolute-project-root>");
    expect(option(integrationInit, "--name")).toBe("<project-name>");
  });

  test("captures a bounded Decision from persisted Evidence before completing v2 work", async () => {
    const review = await readSkill("ezagent-review");
    const completion = structuredContract(review, "completion");

    expect(completion).toEqual({
      knowledgeRequiredBeforeStatus: "completed",
      currentKnowledgePersistence: "available",
      currentAction: "capture-and-complete",
      resultStatus: "completed",
    });
    expect(argvFor(review, "work-review")).toBeDefined();
    expect(argvFor(review, "work-complete")).toBeDefined();
    expect(review.body).toMatch(/每个 Slice.*最新 Evidence/su);
    expect(review.body).toMatch(/Decision.*标题、摘要、决策、约束和后续事项/su);
    expect(argvExamples(review).some((argv) => option(argv, "--to") === "completed")).toBe(true);
    expect(review.body).toMatch(/v1 Knowledge.*决策、约束、验证证据.*后续事项/su);
    expect(review.body).toMatch(/不保存.*聊天、完整用户提示或完整专家提示/u);
  });

  test("transitions a completed implementation to verifying before review handoff", async () => {
    const implement = await readSkill("ezagent-implement");
    const handoff = structuredContract(implement, "reviewHandoff");
    const toVerifying = argvExamples(implement).find(
      (argv) => argv.includes("transition") && option(argv, "--to") === "verifying",
    );

    expect(handoff).toEqual({
      kind: "task",
      fromStatus: "implementing",
      toStatus: "verifying",
      targetSkill: "ezagent-review",
      onTransitionFailure: "fail-closed",
    });
    expect(toVerifying).toBeDefined();
    expect(option(toVerifying!, "--revision")).toBe("<active-work-item-revision>");
    expect(implement.body).toMatch(/transition.*成功.*才.*Review/su);
  });

  test("keeps state, filesystem, network, and Git authority fail closed", async () => {
    const skills = await Promise.all(EXPECTED_SKILLS.map(readSkill));
    const affirmativeExternalCommands = [
      /(^|\n)\s*(?:[-*]\s*)?`?git\s+(?:add|commit|push|branch|switch|checkout|tag|stash|rebase|merge)\b/mu,
      /(^|\n)\s*(?:[-*]\s*)?`?(?:npm|pnpm|yarn)\s+(?:install|add)\b/mu,
      /(^|\n)\s*(?:[-*]\s*)?`?(?:curl|wget)\b/mu,
    ];

    for (const skill of skills) {
      expect(skill.body).toContain("不得直接编辑 `.ezagent/**`");
      expect(skill.body).toMatch(/(?:所有状态变化|状态写入).*本地核心.*验证/u);
      expect(skill.body).toMatch(/不得自动.*(?:联网|网络)/u);
      expect(skill.body).toMatch(/不得自动.*Git.*写/u);
      expect(skill.body).toMatch(/不得自动.*(?:发布|上传)/u);
      for (const pattern of affirmativeExternalCommands) expect(skill.body).not.toMatch(pattern);
    }
  });

  test("binds optional v2 multi-Agent delegation to one Work Slice", async () => {
    const spec = await readSkill("ezagent-spec");
    const execute = await readSkill("ezagent-execute");
    const requiredFields = [
      "Work Item ID",
      "Work Spec ID",
      "Slice ID",
      "delegation ID",
      "scope",
      "deliverables",
      "Evidence requirements",
    ];

    for (const skill of [spec, execute]) {
      for (const field of requiredFields) expect(skill.body).toContain(field);
      expect(skill.body).toMatch(/Specialist.*多 Agent/su);
      expect(skill.body).toMatch(/不(?:保存|持久化).*完整.*提示/u);
    }
  });

  test("executes approved delegations through matching isolated project Agents and bounded receipts", async () => {
    const execute = await readSkill("ezagent-execute");
    const review = await readSkill("ezagent-review");

    for (const skill of [execute, review]) {
      expect(argvFor(skill, "delegation-start")).toBeDefined();
      expect(argvFor(skill, "delegation-complete")).toBeDefined();
      expect(skill.body).toMatch(/expertId.*project Agent/su);
      expect(skill.body).toMatch(/不得.*(?:模拟|替换)/u);
      expect(skill.body).toMatch(/有界.*(?:摘要|审查摘要).*result hash|结果 hash/su);
      expect(skill.body).toMatch(/不(?:得|传).*完整.*(?:聊天|提示)/u);
      expect(skill.body).toMatch(/返回.*dispatch.*原样.*subagent/su);
      expect(skill.body).toContain("dispatchFingerprint");
    }
    expect(execute.body).toMatch(/协调器.*不得.*自行接管/u);
    expect(review.body).toMatch(/实现者.*不得.*批准自己的输出/u);
    expect(review.body).toMatch(/mixed.*独立 review completion.*人工 Evidence/su);
    expect(review.body).toMatch(/Criterion Evidence coverage.*Delegation coverage/su);
  });

  test("limits Specialist replan to an exact approved execution-strategy diff", async () => {
    const execute = await readSkill("ezagent-execute");

    expect(argvFor(execute, "specialist-replan-preview")).toBeDefined();
    expect(argvFor(execute, "specialist-replan-apply")).toBeDefined();
    expect(execute.body).toMatch(/没有已开始但未完成的 receipt/su);
    expect(execute.body).toMatch(/不得改变 Outcome、Scope、Non-goals.*Acceptance Criteria.*Approval Points/su);
    expect(execute.body).toMatch(/added、removed、changed、unchanged.*用户.*批准/su);
    expect(execute.body).toMatch(/不得用 replan 覆盖未完成委派/u);
  });

  test("does not create optional Skill scaffolding or placeholders", async () => {
    for (const directory of EXPECTED_SKILLS) {
      const skillDirectory = `${SKILLS_ROOT}${directory}/`;
      expect(await readdir(skillDirectory)).toEqual(["SKILL.md"]);
      const path = `${skillDirectory}SKILL.md`;
      const contents = await readFile(path, "utf8");
      expect(contents).not.toMatch(/TODO|TBD|\[TODO:/u);
    }
  });
});
