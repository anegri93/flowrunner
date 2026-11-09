// Servidores de prueba en puertos libres, sin chocar con nada.
export { freePort } from "../../src/probar/herramientas.ts";

/** Un servidor HTTP en Node que responde `body` en `port`, como script para `node -e` o un archivo. */
export const serverScript = (port: number, body = "ok") =>
  `require("node:http").createServer((q, r) => r.end(${JSON.stringify(body)} + " " + q.method + " " + q.url)).listen(${String(port)}, "127.0.0.1");\n`;
