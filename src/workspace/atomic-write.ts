import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

// The temporary file is synced before its atomic rename; parent-directory durability remains platform-dependent.
export async function atomicWriteText(target: string, content: string): Promise<void> {
  const parent = dirname(target);
  // Keep the adjacent staging basename bounded independently of the target basename.
  const temporary = join(parent, `.ezagent-write.${process.pid}.${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let ownsTemporary = false;
  let failed = false;
  let failure: unknown;

  await mkdir(parent, { recursive: true });

  try {
    file = await open(temporary, "wx");
    ownsTemporary = true;
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, target);
    ownsTemporary = false;
  } catch (error: unknown) {
    failed = true;
    failure = error;
  }

  let cleanupFailure: unknown;
  if (file !== undefined) {
    try {
      await file.close();
    } catch (error: unknown) {
      cleanupFailure = error;
    }
  }
  if (ownsTemporary) {
    try {
      await rm(temporary, { force: true });
    } catch (error: unknown) {
      cleanupFailure ??= error;
    }
  }

  if (failed) {
    throw failure;
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }
}
