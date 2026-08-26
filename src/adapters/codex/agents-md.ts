const START = "<!-- EZAGENT:START -->";
const END = "<!-- EZAGENT:END -->";

export type EzagentAgentsMarkerErrorCode =
  | "missing-start"
  | "missing-end"
  | "duplicate-start"
  | "duplicate-end"
  | "reversed"
  | "unclosed-code-fence";

export class EzagentAgentsMarkerError extends Error {
  readonly code: EzagentAgentsMarkerErrorCode;

  constructor(code: EzagentAgentsMarkerErrorCode) {
    super(`invalid EZagent managed markers: ${code}`);
    this.name = "EzagentAgentsMarkerError";
    this.code = code;
  }
}

const RULES = [
  "## EZagent Work Harness",
  "",
  "仅当项目根目录存在 `.ezagent/project.yaml` 时，需要分析、创建、修改、执行、审查或跨会话恢复的 Agent 工作都必须自动使用 `$ezagent-router`；只有用户要求的结果本身只是解释或一次性判断，且没有要求产出、修改或开始项目流程时，才可作为只读咨询直接回答。不要要求用户手动输入 EZagent 命令。",
  "Router 是相关请求的顶层工作流所有者；其他 brainstorming、planning、coding 或 review 能力只有在 Router 选定模式并实际转交后才能作为辅助能力使用。",
  "必须先根据用户要求的 Outcome、影响和可逆性选择模式，再处理 blocker、未决问题或假设。源码或数据缺失、当前是只读 sandbox、CodeGraph 等辅助工具不可用或权限不足，都不得把请求降级为 Consult；这些条件只能在 Router 选定模式并实际转交后记录和处理。",
  "每次相关工作开始，先调用插件内打包 CLI 的 `context --root <project-root> --json` 读取当前状态；context 只是准备动作，不代表完成路由；不得直接编辑 `.ezagent/**`。",
  "Router 必须选择最轻且足够可靠的 Consult、Quick、Brief、Standard 或 Controlled Mode；岗位、部门和业务类型不得成为固定角色枚举或专属流程。",
  "新的 v2 Work Item 按 Brief、Work Spec、Slices、Evidence、Work Journal 与 Decision 执行；旧 v1 编码 Task 才恢复已批准专家团队和原质量门。",
  "Specialist 与多 Agent 不是默认前置；但每个持久化 v2 Work Contract 都必须显式记录 Specialist Assessment：说明 not-needed，或提交不含 expert ID 和固定人数的有界 Capability Needs。",
  "有已批准 delegation 时必须调用匹配 expertId 的 project Agent，不得由协调器模拟或替换；消息和回执只绑定 Work Item、Work Spec、Slice、delegation、范围、交付物和 Evidence requirements。",
  "发送、发布、外部写入或其他 Side Effect 必须命中精确 Approval Point，经用户单独批准；本地授权记录不等于外部动作已经执行。",
  "不得自动联网、安装软件、执行任何 Git 写操作、发布或上传项目。",
] as const;

interface Fence {
  readonly character: "`" | "~";
  readonly length: number;
}

interface ManagedMarkers {
  readonly starts: number[];
  readonly ends: number[];
  readonly hasUnclosedCodeFence: boolean;
}

function openingFence(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match === null) return undefined;

  const run = match[1]!;
  const remainder = match[2]!;
  const character = run[0] as "`" | "~";
  if (character === "`" && remainder.includes("`")) return undefined;

  return { character, length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[\t ]*$/u.exec(line);
  if (match === null) return false;

  const run = match[1]!;
  return run[0] === fence.character && run.length >= fence.length;
}

function managedMarkers(contents: string): ManagedMarkers {
  const starts: number[] = [];
  const ends: number[] = [];
  const newlines = /\r\n|\n/gu;
  let lineStart = 0;
  let fence: Fence | undefined;

  const visitLine = (lineEnd: number): void => {
    const line = contents.slice(lineStart, lineEnd);

    if (fence !== undefined) {
      if (closesFence(line, fence)) fence = undefined;
      return;
    }

    const opened = openingFence(line);
    if (opened !== undefined) {
      fence = opened;
      return;
    }

    if (line === START) starts.push(lineStart);
    if (line === END) ends.push(lineStart);
  };

  for (const newline of contents.matchAll(newlines)) {
    visitLine(newline.index);
    lineStart = newline.index + newline[0].length;
  }
  visitLine(contents.length);

  return { starts, ends, hasUnclosedCodeFence: fence !== undefined };
}

export function mergeEzagentAgentsBlock(existing: string): string {
  const { starts, ends, hasUnclosedCodeFence } = managedMarkers(existing);
  if (hasUnclosedCodeFence) {
    throw new EzagentAgentsMarkerError("unclosed-code-fence");
  }
  if (starts.length > 1) throw new EzagentAgentsMarkerError("duplicate-start");
  if (ends.length > 1) throw new EzagentAgentsMarkerError("duplicate-end");
  if (starts.length === 0 && ends.length === 1) {
    throw new EzagentAgentsMarkerError("missing-start");
  }
  if (starts.length === 1 && ends.length === 0) {
    throw new EzagentAgentsMarkerError("missing-end");
  }
  if (starts.length === 1 && ends.length === 1 && starts[0]! > ends[0]!) {
    throw new EzagentAgentsMarkerError("reversed");
  }

  const newline = /\r\n|\n/u.exec(existing)?.[0] ?? "\n";
  const block = [START, ...RULES, END].join(newline);

  if (starts.length === 1 && ends.length === 1) {
    const start = starts[0]!;
    const end = ends[0]! + END.length;
    return `${existing.slice(0, start)}${block}${existing.slice(end)}`;
  }

  const separator =
    existing.length === 0 || existing.endsWith(`${newline}${newline}`)
      ? ""
      : existing.endsWith(newline)
        ? newline
        : `${newline}${newline}`;

  return `${existing}${separator}${block}${newline}`;
}
