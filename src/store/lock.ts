// Si un proceso sigue vivo: lo usan los lugares, los turnos y los locks de tick y aprender.
import { readFileSync, writeFileSync } from "node:fs";

export function isAlive(pid: number): boolean {
  // `kill(0)` o un pid negativo apuntan a un grupo de procesos, no a uno: nunca son el dueño de un lock.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Un lock de archivo con el pid: si el dueño murió, se toma. Lo usan tick, aprender y self-update. */
export function tryLock(file: string): boolean {
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    const pid = Number(readFileSync(file, "utf8"));
    if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid)) return false;
    writeFileSync(file, String(process.pid));
    return true;
  }
}
