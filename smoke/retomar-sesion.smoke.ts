// T4.1 de flowrunner 2.0: ¿se puede retomar la sesión del planificador para implementar? Con el SDK real,
// una sesión abierta en la carpeta A se retoma (1) desde otra carpeta B y (2) en la misma carpeta con otras
// herramientas. Lo que pase decide si una_sesion implementa en su propio worktree o en el de la feature
// (ADR 0045). Deja lo que vio en un archivo JSON, para pegarlo en el ADR.
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { collect, copyToyRepo, isolatedOptions } from "./helpers.ts";

const permitir =
  (tools: readonly string[]): NonNullable<Options["canUseTool"]> =>
  (name) =>
    Promise.resolve(
      tools.includes(name)
        ? { behavior: "allow", updatedInput: {} }
        : { behavior: "deny", message: `${name} no está permitida acá` },
    );

/** El resultado de una sesión: si terminó bien, su error y los tokens de entrada del primer turno. */
function resumen(messages: SDKMessage[]) {
  const result = messages.find((m) => m.type === "result");
  const usage = (result as { usage?: Record<string, number> } | undefined)?.usage ?? {};
  return {
    subtype: result?.subtype ?? "sin resultado",
    error: (result as { errors?: string[] } | undefined)?.errors?.join("; ") ?? "",
    respuesta: (result as { result?: string } | undefined)?.result ?? "",
    entrada:
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
  };
}

test("retomar la sesión del planificador: desde otra carpeta y con otras herramientas", async () => {
  const a = copyToyRepo();
  const b = mkdtempSync(join(tmpdir(), "flowrunner-toy-b-"));
  cpSync(a, b, { recursive: true });
  const sessionId = randomUUID();
  const lectura = await collect(
    "Leé src/pedidos.js con Read y respondé solo con la palabra: listo.",
    isolatedOptions(a, {
      sessionId,
      persistSession: true,
      allowedTools: ["Read"],
      canUseTool: permitir(["Read"]),
    }),
  );
  const escribir = (carpeta: string, archivo: string) =>
    collect(
      `Escribí con Write el archivo ${archivo} en tu directorio actual, con el contenido: ok. Después respondé solo con el nombre del archivo que leíste antes en esta conversación, o «ninguno».`,
      isolatedOptions(carpeta, {
        resume: sessionId,
        persistSession: true,
        allowedTools: ["Read", "Write"],
        canUseTool: permitir(["Read", "Write"]),
      }),
    ).catch((error: unknown) => [
      { type: "result", subtype: "excepcion", errors: [String(error)] } as unknown as SDKMessage,
    ]);
  const otraCarpeta = await escribir(b, "desde-b.txt");
  const mismaCarpeta = await escribir(a, "desde-a.txt");
  const informe = {
    planificador: resumen(lectura),
    otra_carpeta: { ...resumen(otraCarpeta), escribio: existsSync(join(b, "desde-b.txt")) },
    misma_carpeta: {
      ...resumen(mismaCarpeta),
      escribio:
        existsSync(join(a, "desde-a.txt")) &&
        readFileSync(join(a, "desde-a.txt"), "utf8").includes("ok"),
    },
  };
  // El informe va a un archivo: la salida del smoke no siempre muestra la consola.
  writeFileSync(
    process.env.RETOMAR_SESION_OUT ?? join(tmpdir(), "retomar-sesion.json"),
    `${JSON.stringify(informe, null, 2)}\n`,
  );
  expect(informe.planificador.subtype).toBe("success");
  // Retomar en la misma carpeta tiene que seguir la conversación: si no, el experimento no tiene base.
  expect(informe.misma_carpeta.respuesta).toMatch(/pedidos/);
}, 300_000);
