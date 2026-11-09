// Los procesos que deja una sesión: lo que lanzó el CLI de Claude Code y sigue vivo cuando la sesión ya
// terminó, como un runner de tests que no sale. Se buscan por parentesco, no por grupo: un proceso
// que el Bash del CLI mandó a otro grupo sigue siendo descendiente del CLI.
import { execFileSync } from "node:child_process";

export interface LiveProcess {
  readonly pid: number;
  readonly command: string;
}

/** Los descendientes vivos de `root`, sin `root`. Sin `ps`, ninguno: no hay cómo verlos. */
export function descendants(root: number): LiveProcess[] {
  let table: string;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return [];
  }
  const children = new Map<number, LiveProcess[]>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const [, pid, ppid, command] = match;
    const list = children.get(Number(ppid)) ?? [];
    list.push({ pid: Number(pid), command: (command ?? "").trim() });
    children.set(Number(ppid), list);
  }
  const out: LiveProcess[] = [];
  const pending = [root];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const child of children.get(next) ?? []) {
      out.push(child);
      pending.push(child.pid);
    }
  }
  return out;
}

/** SIGKILL a cada uno; el que ya terminó no es un error. */
export function killAll(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ya no existe
    }
  }
}
