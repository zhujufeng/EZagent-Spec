#!/usr/bin/env node

import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAX_INPUT_BYTES = 1_048_576;
const ROUTER_CONTEXT = [
  "<ezagent-router-required>",
  "检测到当前工作目录位于已初始化的 EZagent 项目。",
  "本回合若涉及分析、创建、修改、执行、审查、策划、文档或跨会话恢复，必须先使用已安装插件的 Router Skill：`ezagent-spec:ezagent-router`（Skill 内引用名为 `$ezagent-router`）。",
  "不得沿用上一需求的模式或工作流。Router 必须先读取当前 context，再为这次用户请求重新选择 Work Mode、说明理由、确定下一个 Skill 并实际转交；纯问候或与项目无关的闲聊可以忽略本提示。",
  "</ezagent-router-required>",
].join("\n");

let input = "";
let finished = false;

function realDirectory(path) {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function realFile(path) {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function findInitializedProject(start) {
  let current = resolve(start);
  while (true) {
    const stateDirectory = join(current, ".ezagent");
    if (
      realDirectory(stateDirectory)
      && realFile(join(stateDirectory, "project.yaml"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function writeContext() {
  if (process.env.PLUGIN_ROOT || process.env.PLUGIN_DATA) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: ROUTER_CONTEXT,
      },
    }));
    return;
  }
  process.stdout.write(ROUTER_CONTEXT);
}

function finish() {
  if (finished) return;
  finished = true;
  try {
    const event = JSON.parse(input.replace(/^\uFEFF/u, ""));
    const cwd = typeof event.cwd === "string" && event.cwd !== ""
      ? event.cwd
      : process.cwd();
    if (findInitializedProject(cwd) === undefined) return;
    writeContext();
  } catch {
    // Hooks are advisory. Invalid or unavailable input must never block a turn.
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (Buffer.byteLength(input, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_INPUT_BYTES) {
    input = "";
    finished = true;
    return;
  }
  input += chunk;
});
process.stdin.on("end", finish);
process.stdin.on("error", () => process.exit(0));
setTimeout(() => {
  finish();
  process.exit(0);
}, 1_000).unref();
