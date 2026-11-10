import { realpathSync } from "node:fs";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/helpers/git.ts";
import type { NewEvent } from "../store/events.ts";
import { tripwireHook, type HookPolicy } from "./hook.ts";

function policy(extra: Partial<HookPolicy> = {}): HookPolicy {
  return {
    scope: {
      root: realpathSync(tempDir("fr-hook-")),
      owner: "ST-2",
      writable: ["src/auth/roles.ts"],
      writeGlobs: [],
      locked: [],
      harness: [],
      lockfiles: [],
      manifests: [],
      depsDeclared: false,
      testGlobs: ["tests/**"],
      comandos: { ampliables: ["pnpm test"], exactos: [], fixers: [] },
    },
    fase: "implementar",
    unidad: "ST-2",
    write: true,
    bash: true,
    agents: false,
    graft: false,
    ...extra,
  };
}

async function call(p: HookPolicy, tool: string, toolInput: Record<string, unknown>) {
  const emitted: NewEvent[] = [];
  const hook = tripwireHook(p, (e) => emitted.push(e));
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: "t1",
    session_id: "s",
    transcript_path: "/x",
    cwd: p.scope.root,
  } as HookInput;
  const out = await hook(input, "t1", { signal: new AbortController().signal });
  const specific =
    (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {};
  return {
    decision: specific.permissionDecision,
    reason: specific.permissionDecisionReason,
    updated: specific.updatedInput,
    emitted,
  };
}

describe("tripwireHook", () => {
  // Si regresiona, el agente escribe fuera de su sub-task y el doble control llega tarde.
  test("Write fuera del alcance: deny con el motivo y un evento de rechazo", async () => {
    const r = await call(policy(), "Write", { file_path: "src/billing/tarifas.ts", content: "x" });
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("src/billing/tarifas.ts está fuera del alcance de ST-2");
    expect(r.emitted).toEqual([
      {
        tipo: "rechazo",
        fase: "implementar",
        unidad: "ST-2",
        herramienta: "Write",
        motivo: r.reason,
      },
    ]);
  });

  // Si regresiona, una herramienta nueva del SDK queda permitida sin que nadie lo decida.
  test("una herramienta que ninguna regla menciona: deny", async () => {
    const r = await call(policy(), "WebFetch", { url: "https://x" });
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/WebFetch no está permitida en implementar/);
  });

  test("Read dentro del worktree: allow sin evento", async () => {
    const r = await call(policy(), "Read", { file_path: "src/auth/roles.ts" });
    expect(r.decision).toBe("allow");
    expect(r.emitted).toEqual([]);
  });

  // Si regresiona, el token de la suscripción vuelve a estar al alcance de los tests del agente (ADR 0013).
  test("Bash permitido se reescribe para correr sin los secretos", async () => {
    const r = await call(policy(), "Bash", { command: "pnpm test", description: "tests" });
    expect(r.decision).toBe("allow");
    expect(r.updated).toEqual({
      command:
        "env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN sh -c 'pnpm test'",
      description: "tests",
    });
  });

  // Regresión de VF-6: `git status --short` y `ls` encadenados se rechazaban por no estar tal cual.
  test("un comando de lectura encadenado pasa por el hook y se reescribe sin secretos", async () => {
    const r = await call(policy(), "Bash", { command: "git status --short; ls src" });
    expect(r.decision).toBe("allow");
    expect((r.updated as { command: string }).command).toMatch(/^env -u /);
  });

  test("una fase de solo lectura no escribe ni corre comandos; graft solo si está habilitado", async () => {
    const readOnly = policy({ fase: "revisar", write: false, bash: false });
    expect(
      (await call(readOnly, "Edit", { file_path: "src/auth/roles.ts", new_string: "y" })).reason,
    ).toBe("revisar no escribe archivos");
    expect((await call(readOnly, "Bash", { command: "pnpm test" })).decision).toBe("deny");
    expect((await call(readOnly, "mcp__graft__graft_repo_map", {})).decision).toBe("deny");
    expect(
      (await call({ ...readOnly, graft: true }, "mcp__graft__graft_repo_map", {})).decision,
    ).toBe("allow");
  });

  // Si regresiona, probar corre código en la máquina con el navegador o escribe capturas fuera del run.
  test("las herramientas MCP permitidas pasan por nombre; una captura no elige dónde escribirse", async () => {
    const tester = policy({
      fase: "probar",
      write: false,
      bash: false,
      mcp: ["mcp__navegador__browser_click", "mcp__navegador__browser_take_screenshot"],
    });
    expect((await call(tester, "mcp__navegador__browser_click", {})).decision).toBe("allow");
    expect((await call(tester, "mcp__navegador__browser_run_code_unsafe", {})).decision).toBe(
      "deny",
    );
    const shot = await call(tester, "mcp__navegador__browser_take_screenshot", {
      filename: "../../.ssh/x.png",
      fullPage: true,
    });
    expect(shot).toMatchObject({ decision: "allow", updated: { fullPage: true } });
    expect(shot.updated).not.toHaveProperty("filename");
  });

  // Si regresiona, los secretos del .env que probar copia al worktree llegan al modelo y al transcript.
  test("un archivo de entorno con secretos no se lee ni queda dentro de una búsqueda", async () => {
    const base = policy({ fase: "probar", write: false, bash: false });
    const tester = { ...base, scope: { ...base.scope, unreadable: [".env"] } };
    expect((await call(tester, "Read", { file_path: ".env" })).reason).toBe(
      ".env tiene secretos del entorno: no se lee",
    );
    expect((await call(tester, "Read", { file_path: `${tester.scope.root}/.env` })).decision).toBe(
      "deny",
    );
    expect((await call(tester, "Grep", { pattern: "SECRET" })).reason).toMatch(
      /^buscar en la raíz incluye \.env/,
    );
    expect((await call(tester, "Grep", { pattern: "x", path: "src" })).decision).toBe("allow");
    expect((await call(tester, "Read", { file_path: "src/a.ts" })).decision).toBe("allow");
  });

  test("Edit dentro del alcance que agrega un secreto: deny", async () => {
    const r = await call(policy(), "Edit", {
      file_path: "src/auth/roles.ts",
      old_string: "a",
      new_string: 'const password = "hunter2hunter2hunter2"',
    });
    expect(r.reason).toMatch(/secreto/);
  });
});
