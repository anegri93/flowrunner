// Los archivos fuera de git que la app necesita para arrancar, como un `.env.local`. El worktree de un
// run sale de git y no los tiene: sin ellos, en rskate, cada `pnpm test:e2e` esperaba 180 s a un
// servidor que no podía arrancar, y el criterio «fallaba» sin haber probado nada (COMPARTIR-1).
// Se copian solo mientras corren los comandos que los necesitan y se borran después: revisar y las
// sub-tasks leen ese worktree, y los secretos no se leen ni se commitean.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export type EnvCopy =
  | { readonly ok: true; readonly remove: () => void }
  | { readonly ok: false; readonly motivo: string };

/** Copia del repo al worktree los que faltan. `remove` borra solo lo que copió. */
export function copyEnvFiles(repo: string, worktree: string, files: readonly string[]): EnvCopy {
  const copied: string[] = [];
  const remove = () => {
    for (const file of copied) rmSync(file, { force: true });
  };
  for (const file of files) {
    const from = join(repo, file);
    const to = join(worktree, file);
    if (!existsSync(from)) {
      remove();
      return { ok: false, motivo: `${file} no existe en ${repo}` };
    }
    if (existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(to);
  }
  return { ok: true, remove };
}

/**
 * Corre `fn` con los archivos copiados y los borra al terminar, pase lo que pase. Sin ninguna sesión
 * de agente adentro: es para los comandos que corre flowrunner. Quien llama ya comprobó que existen
 * (con `copyEnvFiles`), así que si faltan es porque los borraron a mitad del run.
 */
export async function withEnvFiles<T>(
  repo: string,
  worktree: string,
  files: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const copy = copyEnvFiles(repo, worktree, files);
  if (!copy.ok) throw new Error(copy.motivo);
  try {
    return await fn();
  } finally {
    copy.remove();
  }
}
