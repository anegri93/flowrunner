import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookCallback, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { TEST_BIN } from "../../test/helpers/cli.ts";
import { fakeQuery, hanging, stream } from "../../test/helpers/fake-query.ts";
import { newRun, testDeps } from "../../test/helpers/project.ts";
import type { NewEvent } from "../store/events.ts";
import { runSession, type SessionSpec } from "./session.ts";

const allow: HookCallback = () => Promise.resolve({});
const outputSchema = z.object({
  resumen: z.string(),
  decisiones: z.array(z.object({ que: z.string(), por_que: z.string() })),
});

function spec(
  extra: Partial<SessionSpec<z.infer<typeof outputSchema>>> = {},
): SessionSpec<z.infer<typeof outputSchema>> {
  return {
    fase: "planificar",
    nombre: "planificar-1",
    prompt: "planificá",
    cwd: "/tmp",
    model: { model: "claude-opus-5-5", effort: "high" },
    tools: ["Read"],
    hook: allow,
    schema: outputSchema,
    maxBudgetUsd: 3,
    timeoutMs: 60_000,
    ...extra,
  };
}

function runtime(
  query: ReturnType<typeof fakeQuery>["query"],
  env: NodeJS.ProcessEnv = { FLOWRUNNER_AUTH: "login", PATH: process.env.PATH ?? "" },
) {
  const run = newRun("/repo");
  const emitted: NewEvent[] = [];
  return {
    run,
    emitted,
    rt: { run, deps: testDeps({ query, env }), emit: (e: NewEvent) => emitted.push(e) },
  };
}

describe("runSession", () => {
  // Si regresiona, un plan que no cumple su forma pasa como bueno a aprobar.
  test("éxito con salida estructurada: devuelve el objeto validado y un evento de uso", async () => {
    const fake = fakeQuery(stream("salida-estructurada"));
    const { rt, emitted, run } = runtime(fake.query);
    const result = await runSession(spec(), rt);
    expect(result.tipo).toBe("ok");
    expect(result.tipo === "ok" && result.output.decisiones.length).toBeGreaterThan(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      tipo: "uso",
      fase: "planificar",
      sesion: "planificar-1",
      modelo: "claude-opus-5-5",
    });
    const copied = readFileSync(join(run.dir, "sesiones", "planificar-1.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(copied).toHaveLength(stream("salida-estructurada").length);
  });

  test("una salida que no cumple el schema de flowrunner es falla de gate", async () => {
    const fake = fakeQuery(stream("salida-estructurada"));
    const { rt } = runtime(fake.query);
    const strict = spec({ schema: outputSchema.extend({ obligatorio: z.string() }) });
    expect(await runSession(strict, rt)).toMatchObject({ tipo: "falla", clase: "gate" });
  });

  test("reintentos de schema agotados es falla de gate", async () => {
    const { rt } = runtime(fakeQuery(stream("schema-agotado")).query);
    expect(await runSession(spec(), rt)).toMatchObject({
      tipo: "falla",
      clase: "gate",
      motivo: "planificar no logró una salida que cumpla su schema",
    });
  });

  // Si regresiona, una sesión colgada frena el run para siempre o se reintenta como fallo del modelo.
  test("el timeout es falla de infraestructura y el stream parcial queda copiado", async () => {
    const partial = stream("cortada-por-timeout").slice(0, 2);
    const fake = fakeQuery((options) =>
      (async function* () {
        yield* partial;
        yield* hanging(options);
      })(),
    );
    const { rt, run } = runtime(fake.query);
    const result = await runSession(spec({ timeoutMs: 100 }), rt);
    expect(result).toMatchObject({ tipo: "falla", clase: "infra" });
    expect(result.tipo === "falla" && result.motivo).toMatch(/timeout/);
    expect(
      readFileSync(join(run.dir, "sesiones", "planificar-1.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(2);
  });

  test("un stream que termina sin resultado es falla de infraestructura", async () => {
    const { rt } = runtime(fakeQuery(stream("cortada-por-timeout")).query);
    expect(await runSession(spec(), rt)).toMatchObject({
      tipo: "falla",
      clase: "infra",
      motivo: "la sesión planificar-1 terminó sin resultado",
    });
  });

  // Si regresiona, el run sigue pegándole a la suscripción después de que el SDK dijo que no.
  test("un rate_limit_event rechazado devuelve limite con la hora de reinicio", async () => {
    const messages = stream("salida-estructurada").map((m): SDKMessage =>
      m.type === "rate_limit_event"
        ? {
            ...m,
            rate_limit_info: {
              ...m.rate_limit_info,
              status: "rejected" as const,
              resetsAt: 1_794_042_000,
            },
          }
        : m,
    );
    const { rt } = runtime(fakeQuery(messages).query);
    expect(await runSession(spec(), rt)).toEqual({ tipo: "limite", hasta: 1_794_042_000_000 });
  });

  // Si regresiona, una sesión de flowrunner carga los hooks, MCP o conectores del repo o del usuario.
  test("las opciones llevan settingSources vacío, solo los MCP declarados, deny por defecto y sin persistir", async () => {
    const fake = fakeQuery(stream("salida-estructurada"));
    const { rt } = runtime(fake.query);
    const graft = { type: "stdio" as const, command: "graft", args: ["mcp"] };
    await runSession(spec({ mcpServers: { graft } }), rt);
    const options = fake.calls[0]?.options;
    expect(options?.settingSources).toEqual([]);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.mcpServers).toEqual({ graft });
    expect(options?.persistSession).toBe(false);
    expect(options?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(options?.outputFormat?.type).toBe("json_schema");
    const denied = await options?.canUseTool?.("Write", {}, {} as never);
    expect(denied?.behavior).toBe("deny");
  });

  // Si regresiona, flowrunner reintenta tres veces con una credencial que Claude ya rechazó.
  test("una sesión sin credencial válida es falla de entorno, no de infraestructura", async () => {
    const { rt } = runtime(fakeQuery(stream("sin-sesion")).query, {
      PATH: `${TEST_BIN}:${process.env.PATH ?? ""}`,
      FAKE_KEYCHAIN_TOKEN: "tok",
    });
    const result = await runSession(spec(), rt);
    expect(result).toMatchObject({ tipo: "falla", clase: "entorno" });
    expect(result.tipo === "falla" && result.motivo).toMatch(/rechazó la credencial/);
  });

  // Si regresiona, en modo login el motivo manda a revisar un token del Keychain que no existe.
  test("en modo login, sin sesión, el motivo dice cómo revisar la sesión de Claude Code", async () => {
    const { rt } = runtime(fakeQuery(stream("sin-sesion")).query);
    const result = await runSession(spec(), rt);
    expect(result).toMatchObject({ tipo: "falla", clase: "entorno" });
    const motivo = result.tipo === "falla" ? result.motivo : "";
    expect(motivo).toContain("Claude Code no encontró tu sesión");
    expect(motivo).toContain("claude auth status");
    expect(motivo).not.toContain("token");
  });

  test("sin token en el Keychain es una falla de entorno que explica cómo generarlo", async () => {
    const fake = fakeQuery(stream("salida-estructurada"));
    const { rt } = runtime(fake.query, { PATH: `${TEST_BIN}:${process.env.PATH ?? ""}` });
    const result = await runSession(spec(), rt);
    expect(result).toMatchObject({ tipo: "falla", clase: "entorno" });
    expect(result.tipo === "falla" && result.motivo).toMatch(/claude setup-token/);
    expect(fake.calls).toHaveLength(0);
  });

  test("con token en el Keychain la sesión lo recibe junto a una config de Claude propia", async () => {
    const fake = fakeQuery(stream("salida-estructurada"));
    const { rt, run } = runtime(fake.query, {
      PATH: `${TEST_BIN}:${process.env.PATH ?? ""}`,
      FAKE_KEYCHAIN_TOKEN: "tok-123",
    });
    await runSession(spec(), rt);
    expect(fake.calls[0]?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-123");
    expect(fake.calls[0]?.options?.env?.CLAUDE_CONFIG_DIR).toBe(join(run.home, "claude"));
  });
});
