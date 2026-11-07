// Un run por repo a la vez. El lock guarda el run y el pid de su proceso (spec, sección 5).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const lockSchema = z.strictObject({ run_id: z.string(), pid: z.int() });
export type LockHolder = z.infer<typeof lockSchema>;

/** Cómo está el run que tiene el lock, según su propio log. */
export type HolderStatus = "terminado" | "esperando" | "activo";

export class LockHeldError extends Error {
  readonly holder: LockHolder;
  constructor(project: string, holder: LockHolder) {
    super(`el repo de ${project} ya tiene un run en curso: ${holder.run_id}`);
    this.name = "LockHeldError";
    this.holder = holder;
  }
}

export function lockFile(home: string, project: string): string {
  return join(home, "locks", `${project}.lock`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(home: string, project: string): LockHolder | undefined {
  try {
    return lockSchema.parse(JSON.parse(readFileSync(lockFile(home, project), "utf8")));
  } catch {
    return undefined;
  }
}

/** El lock se toma si su run terminó, o si no espera y su proceso ya no existe. */
export function isStale(
  holder: LockHolder,
  status: (runId: string) => HolderStatus,
  alive: (pid: number) => boolean = isAlive,
): boolean {
  const holderStatus = status(holder.run_id);
  if (holderStatus === "terminado") return true;
  if (holderStatus === "esperando") return false;
  return !alive(holder.pid);
}

export function acquireLock(
  home: string,
  project: string,
  runId: string,
  pid: number,
  status: (runId: string) => HolderStatus,
  alive: (pid: number) => boolean = isAlive,
): void {
  const file = lockFile(home, project);
  mkdirSync(dirname(file), { recursive: true });
  const content = JSON.stringify({ run_id: runId, pid });
  try {
    // `wx` falla si el archivo existe: dos runs que llegan a la vez no toman el lock los dos.
    writeFileSync(file, content, { flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const current = readLock(home, project);
  if (current !== undefined && current.run_id !== runId && !isStale(current, status, alive)) {
    throw new LockHeldError(project, current);
  }
  writeFileSync(file, content);
}

/** Suelta el lock solo si lo tiene este run. */
export function releaseLock(home: string, project: string, runId: string): void {
  if (readLock(home, project)?.run_id === runId) rmSync(lockFile(home, project), { force: true });
}
