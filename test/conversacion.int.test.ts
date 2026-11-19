// Gate de la Fase 1 de flowrunner 2.0 (ADR 0043 y 0044): la conversación decide. Con el CLI real,
// preparar y aprobar de verdad y el resto falso: una feature con aclaraciones con tema pasa feature
// check sin avisos de lo que faltó preguntar; el planificador pregunta, la persona responde, y con
// `aprobar: si_hace_falta` el plan sigue solo a implementar hasta la PR.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readLog } from "../src/store/run-log.ts";
import { homeWith, runCli } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git.ts";
import { makeProject } from "./helpers/project.ts";
import { executions, FAKE_PHASES, runDir, stateNow, waitFor, waitStopped } from "./helpers/runs.ts";

const FEATURE = `---
clave: SHOP-214
proyecto: acme-api
titulo: Exportar pedidos a CSV
---
## Descripción
Un administrador descarga los pedidos como CSV.

## Criterios
- AC-1: GET /pedidos.csv devuelve text/csv.

## Aclaraciones
- P (error): ¿Y si la consulta falla? R: Devuelve 500 sin un CSV a medias.
- P (borde): ¿Y un rango sin pedidos? R: Devuelve solo el encabezado.
`;

describe("la conversación decide (flowrunner 2.0)", () => {
  // Si regresiona, alguna pieza de la Fase 1 no encaja con las otras: feature check vuelve a pedir lo
  // que ya se preguntó, la pregunta del planificador no se puede contestar, la respuesta no retoma
  // planificar, o el plan vuelve a esperar una aprobación que no decide nada.
  test("feature check sin avisos de tema, el planificador pregunta, responder retoma y aprobar sigue sola", async () => {
    const { work } = makeProject({ config: { aprobar: "si_hace_falta" } });
    const env: NodeJS.ProcessEnv = {
      ...homeWith(`github_user: yo\nprojects:\n  - { name: acme-api, path: ${work} }\n`),
      FLOWRUNNER_TEST_HOOKS: FAKE_PHASES,
      FAKE_KEEP_REAL: "preparar,aprobar",
      FAKE_PLANIFICAR_PREGUNTA: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    };
    const home = join(env.HOME ?? "", ".flowrunner");
    const feature = join(tempDir(), "SHOP-214.md");
    writeFileSync(feature, FEATURE);
    const w = { home, env, repo: work, feature };

    const checked = runCli(["feature", "check", feature, "--json"], env);
    expect(checked.status, checked.stderr).toBe(0);
    const avisos = (JSON.parse(checked.stdout) as { avisos: string[] }).avisos;
    expect(avisos.filter((a) => a.includes("ninguna aclaración"))).toEqual([]);

    const started = runCli(["run", feature, "--json"], env);
    expect(started.status, started.stderr).toBe(0);
    const id = (JSON.parse(started.stdout) as { id: string }).id;
    await waitStopped(w, id, 60_000);
    expect(stateNow(w, id)).toMatchObject({ status: "detenido", fase: "planificar" });

    const answered = runCli(["responder", id, "va la propuesta", "--json"], env);
    expect(answered.status, answered.stdout + answered.stderr).toBe(0);
    await waitFor("el run entregado", () => stateNow(w, id).status === "entregado");

    const events = readLog(runDir(w, id)).events;
    expect(events).toContainEqual(
      expect.objectContaining({ tipo: "respondido", respuesta: "va la propuesta" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ tipo: "aprobado", origen: "flowrunner" }),
    );
    // Nunca esperó la aprobación de la persona.
    expect(
      events.some(
        (e) =>
          e.tipo === "accion_terminada" && e.fase === "aprobar" && e.resultado.tipo === "espera",
      ),
    ).toBe(false);
    expect(executions(w, id).filter((f) => f === "planificar")).toHaveLength(2);
    expect(executions(w, id)).toContain("implementar");
  });
});
