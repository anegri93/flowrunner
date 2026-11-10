// Si un proceso sigue vivo: lo usan los lugares, los turnos y los locks de tick y aprender.

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
