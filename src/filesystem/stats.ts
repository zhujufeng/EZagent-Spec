import type { BigIntStats, Stats } from "node:fs";
import {
  lstat as nodeLstat,
  open as nodeOpen,
  stat as nodeStat,
} from "node:fs/promises";

export type PortableStats = Stats | BigIntStats;

export interface StableFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export function exactInteger(value: number | bigint): bigint | undefined {
  if (typeof value === "bigint") return value;
  return Number.isSafeInteger(value) ? BigInt(value) : undefined;
}

export function stableFileIdentity(stat: PortableStats): StableFileIdentity | undefined {
  const dev = exactInteger(stat.dev);
  const ino = exactInteger(stat.ino);
  return dev !== undefined && dev > 0n && ino !== undefined && ino > 0n
    ? { dev, ino }
    : undefined;
}

export function boundedStatSize(stat: PortableStats, maximum: number): number | undefined {
  const size = exactInteger(stat.size);
  if (size === undefined || size < 0n || size > BigInt(maximum)) return undefined;
  return Number(size);
}

export function statMtimeNanoseconds(stat: PortableStats): bigint | undefined {
  if ("mtimeNs" in stat && typeof stat.mtimeNs === "bigint") return stat.mtimeNs;
  if (typeof stat.mtimeMs !== "number" || !Number.isFinite(stat.mtimeMs)) return undefined;
  const wholeMilliseconds = Math.trunc(stat.mtimeMs);
  if (!Number.isSafeInteger(wholeMilliseconds)) return undefined;
  const fractionalNanoseconds = Math.round((stat.mtimeMs - wholeMilliseconds) * 1_000_000);
  return BigInt(wholeMilliseconds) * 1_000_000n + BigInt(fractionalNanoseconds);
}

export function statMtimeMilliseconds(stat: PortableStats): number | undefined {
  if (typeof stat.mtimeMs === "number") {
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : undefined;
  }
  const milliseconds = Number(stat.mtimeMs);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export async function lstatBigint(path: string): Promise<BigIntStats> {
  return nodeLstat(path, { bigint: true });
}

export async function statBigint(path: string): Promise<BigIntStats> {
  return nodeStat(path, { bigint: true });
}

export async function openBigint(path: string, flags: string | number, mode?: number) {
  const handle = await nodeOpen(path, flags, mode);
  return {
    stat: async () => handle.stat({ bigint: true }),
    read: async (buffer: Buffer, offset: number, length: number, position: number | null) => (
      handle.read(buffer, offset, length, position)
    ),
    write: async (buffer: Uint8Array, offset: number, length: number, position: number | null) => (
      handle.write(buffer, offset, length, position)
    ),
    readFile: async () => handle.readFile(),
    writeFile: async (contents: string, encoding: "utf8") => { await handle.writeFile(contents, encoding); },
    truncate: async (length: number) => { await handle.truncate(length); },
    sync: async () => { await handle.sync(); },
    close: async () => { await handle.close(); },
  };
}
