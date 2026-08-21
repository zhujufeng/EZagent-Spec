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
  "## EZagent Spec",
  "",
  "仅当项目根目录存在 `.ezagent/project.yaml` 时，所有开发、修改、修复、重构、实现、审查和验证请求都必须自动使用 `$ezagent-router`；不要要求用户手动输入 EZagent 命令。",
  "每次相关工作开始，先调用插件内打包 CLI 的 `context --root <project-root> --json` 读取当前状态；不得直接编辑 `.ezagent/**`。",
  "每次相关工作先恢复并核对已批准专家团队；若 `platformSyncStatus` 为 `pending`，先使用插件内 CLI 的 `experts-reconcile`，确认 `ready` 后才能进入 implementing。",
  "所有工作必须遵循当前流程等级要求的批准、任务状态和质量门；高风险动作还需要单独的一次性授权。",
  "多 Agent 委派必须绑定 Requirement/Spec/Task ID、专家 ID、delegation ID、范围、交付物和对应质量门。",
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
