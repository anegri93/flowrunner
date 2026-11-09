// Los llamadores de lo que el plan cambia. Si el plan declara que cambia la firma o el contrato de una
// función o un método, cada archivo que lo llama tiene que estar en el alcance de alguna sub-task: si
// no, nadie lo puede adaptar, verificar lo encuentra roto y devuelve trabajo que ninguna sub-task puede
// hacer (CUENTAS-1, con dos seeds que llamaban a `asegurarAcceso`).
//
// La búsqueda es por texto sobre los archivos versionados, no con graft: graft no ve la llamada que
// pasa por una variable sin tipo declarado, como `const usuarios = app.get(UsuariosService)`, y esos
// eran justo los seeds.
import { git, GitError } from "../git/git.ts";
import type { Plan } from "./plan.ts";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalize = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
const covers = (scope: string, file: string) => file === scope || file.startsWith(`${scope}/`);

/** `git grep -l`: los archivos versionados que coinciden; ninguno no es un error. */
async function grepFiles(worktree: string, args: string[], env: NodeJS.ProcessEnv) {
  try {
    const out = await git(worktree, ["grep", "-l", ...args], env);
    return out === "" ? [] : out.split("\n");
  } catch (error) {
    if (error instanceof GitError) return [];
    throw error;
  }
}

/**
 * Los archivos que llaman a `simbolo`: una línea con `nombre(`, sin contar las que solo lo mencionan.
 * Con `Clase.metodo`, además el archivo tiene que nombrar la clase, para no confundirlo con un
 * método de otra clase que se llama igual.
 */
export async function callersOf(
  simbolo: string,
  worktree: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const parts = simbolo.split(".");
  const name = parts.at(-1) ?? simbolo;
  const owner = parts.length > 1 ? parts[0] : undefined;
  const calls = await grepFiles(
    worktree,
    ["-E", `(^|[^A-Za-z0-9_$])${escape(name)}[[:space:]]*\\(`],
    env,
  );
  if (owner === undefined || calls.length === 0) return calls;
  const named = new Set(await grepFiles(worktree, ["-w", "-F", owner, "--", ...calls], env));
  return calls.filter((f) => named.has(f));
}

/** Un problema por cada símbolo declarado con llamadores que ninguna sub-task tiene en su alcance. */
export async function callersOutOfScope(
  plan: Pick<Plan, "subtareas" | "tests" | "cambia_lo_existente">,
  worktree: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const scopes = plan.subtareas.flatMap((t) => t.alcance.map(normalize));
  const problems: string[] = [];
  for (const change of plan.cambia_lo_existente) {
    if (change.simbolo === undefined || change.simbolo.trim() === "") continue;
    const orphans = (await callersOf(change.simbolo.trim(), worktree, env)).filter(
      (f) => !plan.tests.includes(f) && !scopes.some((s) => covers(s, f)),
    );
    if (orphans.length > 0)
      problems.push(
        `${change.simbolo} cambia (${change.donde}) y lo llaman archivos que ninguna sub-task tiene en su alcance: ${orphans.join(", ")}. Sumalos al alcance de la sub-task que hace el cambio o de una que dependa de ella`,
      );
  }
  return problems;
}
