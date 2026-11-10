// Motivos que el engine reconoce por su texto: no cambian la clase del outcome, cambian cómo seguir.

export const TOKEN_REJECTED =
  "Claude rechazó la credencial de la sesión: revisá el token del Keychain con `flowrunner doctor`";
export const LOGIN_MISSING =
  "Claude Code no encontró tu sesión: corré `claude auth status` en la terminal y, si no hay sesión, abrí `claude` y corré `/login`";

export const esCredencial = (motivo: string): boolean =>
  motivo.includes(TOKEN_REJECTED) || motivo.includes(LOGIN_MISSING);

/**
 * Cortes de red de git, de Node y de la API de Anthropic. Una lista cerrada: un rojo de código no entra.
 * Sin «unable to access» de git, que también precede a un 403 o a un error de TLS, ni EPIPE, que es un
 * pipe local: esperar no los arregla.
 */
const RED: readonly RegExp[] = [
  /Could not resolve host/i,
  /Failed to connect to/i,
  /Connection (?:timed out|refused|reset)/i,
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/,
  /socket hang up/i,
  /\bfetch failed\b/i,
  /overloaded_error/i,
  /\bAPI Error: (?:5\d\d|529)\b/,
  /error connecting to api\.github\.com/i,
];

export const esFallaDeRed = (motivo: string): boolean => RED.some((r) => r.test(motivo));
