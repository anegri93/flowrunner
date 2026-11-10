import { describe, expect, test } from "vitest";
import { esCredencial, esFallaDeRed, LOGIN_MISSING, TOKEN_REJECTED } from "./motivos.ts";

/** El motivo literal con el que murió el primer VF-6 (`VF-6-20261109-210425`) en preparar. */
const VF6 =
  "git fetch --quiet origin falló: fatal: unable to access 'https://github.com/anegri93/videoFactory.git/': Could not resolve host: github.com";

describe("motivos", () => {
  // Si regresiona, un corte de red vuelve a detener el run a los 25 segundos, como el primer VF-6.
  test("reconoce los cortes de red de git, de Node y de la API", () => {
    for (const motivo of [
      VF6,
      "la sesión implementar-ST-1-1 falló: getaddrinfo ENOTFOUND api.anthropic.com",
      'la sesión planificar-1 falló: API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      "gh pr create falló: error connecting to api.github.com",
    ])
      expect(esFallaDeRed(motivo), motivo).toBe(true);
  });

  // Si regresiona, un rojo de código espera 7,5 minutos antes de detenerse, y parece un corte de red.
  test("un rojo de código o de setup no es de red", () => {
    for (const motivo of [
      "src/a.ts:512:3 error TS2322",
      "el setup `pnpm install` salió 1: ERR_PNPM_OUTDATED_LOCKFILE",
      "AC-1 sigue en rojo: status 500 esperado, llegó 200",
      // git usa «unable to access» para cualquier error HTTP o TLS: un 403 es una credencial, no la red.
      "git push falló: fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403",
      "git fetch falló: fatal: unable to access 'https://github.com/a/b.git/': SSL certificate problem: unable to get local issuer certificate",
      // Un pipe local roto no es un corte de red.
      "el formateador falló: Error: write EPIPE",
    ])
      expect(esFallaDeRed(motivo), motivo).toBe(false);
  });

  // Si regresiona, una credencial rechazada vuelve a ofrecer `resume`, que falla igual (VF-3, VF-4).
  test("reconoce las dos credenciales", () => {
    expect(esCredencial(`implementar: ${TOKEN_REJECTED}`)).toBe(true);
    expect(esCredencial(`planificar: ${LOGIN_MISSING}`)).toBe(true);
    expect(esCredencial("preparar: la base está en rojo")).toBe(false);
  });
});
