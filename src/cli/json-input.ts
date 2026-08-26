import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { readBoundedFileHandle } from "../experts/bounded-read.js";

export const CLI_JSON_INPUT_MAX_BYTES = 65_536;
export const CLI_JSON_ARGV_MAX_BYTES = 24_576;

export interface JsonInputSource {
  readonly chunks: AsyncIterable<Uint8Array | string>;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function parseJsonBytes(
  input: Buffer,
  label: "JSON stdin" | "JSON input file" | "JSON argv input",
): unknown {
  if (input.byteLength === 0) throw new TypeError(`${label} is empty`);
  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    throw new TypeError(`${label} must not contain a UTF-8 BOM`);
  }
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch (error: unknown) {
    throw new TypeError(`${label} must contain valid UTF-8`, { cause: error });
  }
  if (sourceText.includes("\0")) throw new TypeError(`${label} must not contain NUL`);
  const document = sourceText.replace(/^[\x20\t\r\n]*/u, "").replace(/[\x20\t\r\n]*$/u, "");
  if (document.length === 0) throw new TypeError(`${label} is empty`);
  let value: unknown;
  try {
    value = JSON.parse(document) as unknown;
  } catch (error: unknown) {
    throw new TypeError(`${label} must contain exactly one JSON document`, { cause: error });
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError(`${label} root must not be a primitive`);
  }
  return value;
}

export function readBoundedJsonArgument(value: string): unknown {
  if (typeof value !== "string") throw new TypeError("JSON argv input is invalid");
  const bytes = Buffer.from(value, "utf8");
  if (value.length > CLI_JSON_ARGV_MAX_BYTES || bytes.byteLength > CLI_JSON_ARGV_MAX_BYTES) {
    throw new TypeError(`JSON argv input exceeds ${CLI_JSON_ARGV_MAX_BYTES} bytes`);
  }
  return parseJsonBytes(bytes, "JSON argv input");
}

export async function readBoundedJsonInput(source: JsonInputSource): Promise<unknown> {
  if (source === null || typeof source !== "object" || source.chunks === undefined) {
    throw new TypeError("JSON stdin source is invalid");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source.chunks) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    if (buffer.byteLength > CLI_JSON_INPUT_MAX_BYTES - bytes) {
      throw new TypeError(`JSON stdin exceeds ${CLI_JSON_INPUT_MAX_BYTES} bytes`);
    }
    bytes += buffer.byteLength;
    chunks.push(buffer);
  }
  return parseJsonBytes(Buffer.concat(chunks, bytes), "JSON stdin");
}

export async function readBoundedJsonFile(path: string): Promise<unknown> {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("JSON input file path is invalid");
  }
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1) {
    throw new TypeError("JSON input file must be a non-empty regular file");
  }
  if (before.size > CLI_JSON_INPUT_MAX_BYTES) {
    throw new TypeError(`JSON input file exceeds ${CLI_JSON_INPUT_MAX_BYTES} bytes`);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number"
      ? 0
      : constants.O_NOFOLLOW;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new TypeError("JSON input file changed before read");
    const bytes = await readBoundedFileHandle(handle, opened, CLI_JSON_INPUT_MAX_BYTES);
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (!sameFile(opened, after) || !sameFile(opened, pathAfter)) {
      throw new TypeError("JSON input file changed during read");
    }
    return parseJsonBytes(bytes, "JSON input file");
  } finally {
    if (handle !== undefined) await handle.close();
  }
}
