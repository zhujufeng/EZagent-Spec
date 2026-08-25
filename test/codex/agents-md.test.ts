import { describe, expect, it } from "vitest";

import * as agentsMd from "../../src/adapters/codex/agents-md.js";

const { EzagentAgentsMarkerError, mergeEzagentAgentsBlock } = agentsMd;

const START = "<!-- EZAGENT:START -->";
const END = "<!-- EZAGENT:END -->";

describe("mergeEzagentAgentsBlock", () => {
  it("creates one managed block for an empty file", () => {
    const merged = mergeEzagentAgentsBlock("");

    expect(merged.startsWith(`${START}\n`)).toBe(true);
    expect(merged.endsWith(`${END}\n`)).toBe(true);
    expect(merged.match(/EZAGENT:START/gu)).toHaveLength(1);
    expect(merged.match(/EZAGENT:END/gu)).toHaveLength(1);
  });

  it("preserves existing user bytes and appends the managed block", () => {
    const existing = "# Team rules\n\nKeep this line.\n";
    const merged = mergeEzagentAgentsBlock(existing);

    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).toContain("$ezagent-router");
    expect(merged).toContain("`.ezagent/project.yaml`");
  });

  it("replaces an old managed block in place without changing surrounding user bytes", () => {
    const prefix = "# 用户规则\n\n";
    const suffix = "\n\n请保留末尾规则。\n";
    const existing = `${prefix}${START}\n旧规则\n${END}${suffix}`;
    const merged = mergeEzagentAgentsBlock(existing);

    expect(merged.startsWith(prefix)).toBe(true);
    expect(merged.endsWith(suffix)).toBe(true);
    expect(merged).not.toContain("旧规则");
    expect(merged.match(/EZAGENT:START/gu)).toHaveLength(1);
    expect(merged.match(/EZAGENT:END/gu)).toHaveLength(1);
  });

  it("is byte-for-byte idempotent", () => {
    const existing = "# Team rules\n\nKeep this line.\n";
    const once = mergeEzagentAgentsBlock(existing);

    expect(mergeEzagentAgentsBlock(once)).toBe(once);
  });

  it("uses the existing CRLF convention without rewriting user content", () => {
    const existing = "# Team\r\nKeep\r\n";
    const merged = mergeEzagentAgentsBlock(existing);

    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).not.toMatch(/(?<!\r)\n/gu);
    expect(mergeEzagentAgentsBlock(merged)).toBe(merged);
  });

  it.each([
    ["LF", "# First\nSecond\r\n", "\n"],
    ["CRLF", "# First\r\nSecond\n", "\r\n"],
    ["no newline", "# First", "\n"],
  ])("uses the first actual newline convention for mixed input: %s", (_case, existing, newline) => {
    const merged = mergeEzagentAgentsBlock(existing);
    const generated = merged.slice(existing.length);

    expect(merged.startsWith(existing)).toBe(true);
    if (newline === "\r\n") {
      expect(generated).not.toMatch(/(?<!\r)\n/gu);
    } else {
      expect(generated).not.toContain("\r\n");
    }
  });

  it("updates a CRLF managed block in place while preserving surrounding bytes", () => {
    const prefix = "# Team\r\nKeep this\r\n\r\n";
    const suffix = "\r\n\r\nTail stays byte-identical.\n";
    const existing = `${prefix}${START}\r\nold\r\n${END}${suffix}`;
    const merged = mergeEzagentAgentsBlock(existing);
    const block = merged.slice(prefix.length, -suffix.length);

    expect(merged.startsWith(prefix)).toBe(true);
    expect(merged.endsWith(suffix)).toBe(true);
    expect(block).not.toContain("old");
    expect(block).not.toMatch(/(?<!\r)\n/gu);
  });

  it("treats one inline marker as user text and appends a normal managed block", () => {
    const existing = `# Example\nUse \`${START}\` in documentation.\n`;
    const merged = mergeEzagentAgentsBlock(existing);

    expect(merged.startsWith(existing)).toBe(true);
    expect(merged.slice(existing.length)).toContain(`${START}\n## EZagent Work Harness`);
    expect(mergeEzagentAgentsBlock(merged)).toBe(merged);
  });

  it("treats both markers on one line as user text and appends a normal managed block", () => {
    const existing = `Example: ${START} ... ${END}\n`;
    const merged = mergeEzagentAgentsBlock(existing);

    expect(merged.startsWith(existing)).toBe(true);
    expect(merged.slice(existing.length)).toContain(`${START}\n## EZagent Work Harness`);
    expect(mergeEzagentAgentsBlock(merged)).toBe(merged);
  });

  it("treats exact marker lines inside a fenced code example as user text", () => {
    const existing = ["# Example", "```md", START, "old example", END, "```", ""].join("\n");
    const merged = mergeEzagentAgentsBlock(existing);

    expect(merged.startsWith(existing)).toBe(true);
    expect(merged.slice(existing.length)).toContain(`${START}\n## EZagent Work Harness`);
    expect(mergeEzagentAgentsBlock(merged)).toBe(merged);
  });

  it("contains the complete local-only workflow contract", () => {
    const merged = mergeEzagentAgentsBlock("");

    expect(merged).toMatch(/仅当.*\.ezagent\/project\.yaml.*自动使用.*\$ezagent-router/su);
    expect(merged).toMatch(/先.*CLI.*context/su);
    expect(merged).toContain("不得直接编辑 `.ezagent/**`");
    expect(merged).toMatch(/Consult、Quick、Brief、Standard 或 Controlled/u);
    expect(merged).toMatch(/岗位、部门和业务类型不得成为固定角色枚举/u);
    expect(merged).toMatch(/v2 Work Item.*Brief、Work Spec、Slices、Evidence、Work Journal 与 Decision/u);
    expect(merged).toMatch(/Specialist 与多 Agent 不是默认前置/u);
    expect(merged).toMatch(/v2 Work Contract.*显式记录 Specialist Assessment/u);
    expect(merged).toMatch(/approved delegation|已批准 delegation/u);
    expect(merged).toMatch(/project Agent.*不得由协调器模拟或替换/u);
    expect(merged).toMatch(/Side Effect.*精确 Approval Point.*单独批准/su);
    expect(merged).toMatch(/不得自动联网、安装软件/su);
    expect(merged).toMatch(/Git 写操作/su);
    expect(merged).toMatch(/发布或上传/su);
  });

  it("exports a stable managed-marker error type", () => {
    expect(EzagentAgentsMarkerError).toBeTypeOf("function");
  });

  it.each([
    ["unclosed backtick fence", "# Example\n```ts\nconst value = 1;\n"],
    ["unclosed tilde fence", "# Example\n~~~text\ncontent\n"],
    ["mismatched closing character", "```\ncontent\n~~~\n"],
    ["closing run shorter than opening", "````\ncontent\n```\n"],
    ["closing run followed by text", "~~~\ncontent\n~~~ not-a-close\n"],
  ])("fails closed without appending for an unclosed code fence: %s", (_case, contents) => {
    let returned: string | undefined;
    let thrown: unknown;
    try {
      returned = mergeEzagentAgentsBlock(contents);
    } catch (error) {
      thrown = error;
    }

    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(EzagentAgentsMarkerError);
    expect(thrown).toMatchObject({
      name: "EzagentAgentsMarkerError",
      code: "unclosed-code-fence",
    });
  });

  it.each([
    ["missing end", `${START}\n`, "missing-end"],
    ["missing start", `${END}\n`, "missing-start"],
    ["reversed markers", `${END}\n${START}\n`, "reversed"],
    ["duplicate start markers", `${START}\n${START}\n${END}\n`, "duplicate-start"],
    ["duplicate end markers", `${START}\n${END}\n${END}\n`, "duplicate-end"],
    ["two complete managed blocks", `${START}\n${END}\n${START}\n${END}\n`, "duplicate-start"],
  ])("rejects malformed standalone markers with a stable code: %s", (_case, contents, code) => {
    let thrown: unknown;
    try {
      mergeEzagentAgentsBlock(contents);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EzagentAgentsMarkerError);
    expect(thrown).toMatchObject({
      name: "EzagentAgentsMarkerError",
      code,
    });
  });
});
