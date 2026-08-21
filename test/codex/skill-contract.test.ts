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
  "ezagent-spec",
  "ezagent-implement",
  "ezagent-review",
] as const;
const TRANSITION_SKILLS = [
  "ezagent-router",
  "ezagent-spec",
  "ezagent-implement",
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
  test("ships exactly the five concise, implicitly discoverable workflow Skills", async () => {
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

  test("documents the supported high-risk planned-to-implementing authorization combination", async () => {
    const implement = await readSkill("ezagent-implement");
    const highRisk = argvExamples(implement).find((argv) => argv.includes("--high-risk-authorization"));

    expect(highRisk).toBeDefined();
    expect(option(highRisk!, "--to")).toBe("implementing");
    expect(option(highRisk!, "--revision")).toBe("<active-work-item-revision>");
    expect(option(highRisk!, "--high-risk-authorization")).toBe("<authorization-id>");
    expect(implement.body).toMatch(/high.*planned.*implementing/isu);
    expect(implement.body).toMatch(/Spec 批准.*不.*授权/su);
    expect(implement.body).toMatch(/AUTH.*本地核心.*已存在.*绑定.*action/su);
    expect(implement.body).toMatch(/不得.*(?:模型|用户).*编造/u);
    expect(implement.body).toMatch(/授权记录.*不存在.*能力缺失.*停止/su);
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
      targetSkill: "ezagent-implement",
      onTransitionFailure: "fail-closed",
    });
    expect(option(retry, "--to")).toBe("implementing");
    expect(option(retry, "--revision")).toBe("<active-work-item-revision>");
    expect(review.body).toMatch(/verifying.*返工.*不.*planned.*首次授权/su);
    expect(review.body).toMatch(/危险动作.*单独授权/u);
    expect(review.body).toMatch(/transition.*失败.*关闭失败.*不得.*Implement/su);
    expect(review.body).toContain("$ezagent-implement");
    expect(implement.body).toMatch(/status.*planned.*implementing/su);
    expect(implement.body).toMatch(/implementing.*继续/u);
  });

  test("routes automatic selection, approval, readiness, and replan through real commands", async () => {
    const router = await readSkill("ezagent-router");
    const spec = await readSkill("ezagent-spec");
    const implement = await readSkill("ezagent-implement");
    const review = await readSkill("ezagent-review");

    expect(router.body).toContain("team-select-preview");
    expect(router.body).toContain("不得直接提交专家 ID");
    expect(spec.body).toContain("plan-preview");
    expect(spec.body).toContain("与 Spec/Plan 一起确认");
    expect(implement.body).toContain("platformSyncStatus");
    expect(implement.body).toContain("ready");
    expect(implement.body).toContain("replan-preview");
    expect(review.body).toContain("不得审查自己参与实现的 Task");
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
      source: "codex-workspace-root",
      ambiguous: "show-absolute-candidates-and-confirm",
      cwdOnly: false,
      projectNameSource: "confirmed-selection",
    });
    expect(option(integrationInit, "--root")).toBe("<absolute-project-root>");
    expect(option(integrationInit, "--name")).toBe("<project-name>");
  });

  test("keeps review verifying until structured Knowledge is persisted and verified", async () => {
    const review = await readSkill("ezagent-review");
    const completion = structuredContract(review, "completion");

    expect(completion).toEqual({
      knowledgeRequiredBeforeStatus: "completed",
      currentKnowledgePersistence: "unavailable",
      currentAction: "fail-closed",
      retainedStatus: "verifying",
    });
    expect(argvExamples(review).some((argv) => option(argv, "--to") === "completed")).toBe(false);
    expect(review.body).toMatch(/Knowledge.*写入.*读回.*验证.*completed/su);
    expect(review.body).toMatch(/当前.*未打包.*保持.*verifying.*关闭失败/su);
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

  test("binds every multi-Agent delegation to the structured Spec workflow", async () => {
    const spec = await readSkill("ezagent-spec");
    const implement = await readSkill("ezagent-implement");
    const requiredFields = [
      "Requirement ID",
      "Spec ID",
      "Task ID",
      "expert ID",
      "delegation ID",
      "scope",
      "deliverables",
      "gates",
    ];

    for (const skill of [spec, implement]) {
      for (const field of requiredFields) expect(skill.body).toContain(field);
      expect(skill.body).toMatch(/少量.*专家/u);
      expect(skill.body).toMatch(/不固定.*数量/u);
      expect(skill.body).toMatch(/不(?:得|要).*完整.*提示/u);
    }
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
