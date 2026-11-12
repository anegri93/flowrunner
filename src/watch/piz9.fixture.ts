// Fixture de los tests del recorrido y de watch: los eventos de un run con la forma de PIZ-9.
import type { RunStatus } from "../engine/engine.ts";
import type { Phase, RunEvent } from "../store/events.ts";
import { recorridoOf } from "./recorrido.ts";
import type { SessionNode } from "./tree.ts";

// Un run con la forma de PIZ-9: verificar vuelve dos veces con un autofix en el medio, implementar
// se detiene, la persona arregla a mano, revisar vuelve una vez y probar se acepta sin probar.
export const T0 = Date.parse("2026-11-12T13:53:41Z");
export const at = (s: number) => new Date(T0 + s * 1000).toISOString();
export const start = (s: number, fase: Phase): RunEvent => ({
  tipo: "accion_iniciada",
  at: at(s),
  fase,
});
const ok = (s: number, fase: Phase): RunEvent => ({
  tipo: "accion_terminada",
  at: at(s),
  fase,
  resultado: { tipo: "ok" },
});
const back = (s: number, fase: Phase, unidades: string[], motivo: string): RunEvent => ({
  tipo: "accion_terminada",
  at: at(s),
  fase,
  resultado: { tipo: "vuelve", unidades, motivo },
});
const uso = (s: number, fase: Phase, sesion: string, costo: number, unidad?: string): RunEvent => ({
  tipo: "uso",
  at: at(s),
  fase,
  ...(unidad === undefined ? {} : { unidad }),
  sesion,
  modelo: "claude-sonnet-5-5",
  costo_usd: costo,
  tokens_entrada: 1,
  tokens_salida: 1,
  duracion_ms: 1,
});
const unit = (
  s: number,
  unidad: string,
  estado: "iniciada" | "integrada" | "fallida",
): RunEvent => ({ tipo: "unidad", at: at(s), fase: "implementar", unidad, estado });

export const piz9: RunEvent[] = [
  {
    tipo: "run_creado",
    at: at(0),
    run_id: "PIZ-9-x",
    clave: "PIZ-9",
    proyecto: "pizarra",
    repo: "/r",
  },
  start(0, "preparar"),
  ok(41, "preparar"),
  start(41, "planificar"),
  uso(716, "planificar", "planificar-1", 2.91),
  ok(736, "planificar"),
  start(736, "aprobar"),
  { tipo: "accion_terminada", at: at(736), fase: "aprobar", resultado: { tipo: "espera" } },
  { tipo: "aprobado", at: at(748), origen: "orca" },
  start(749, "implementar"),
  unit(778, "ST-1", "iniciada"),
  unit(779, "ST-2", "iniciada"),
  uso(854, "implementar", "implementar-ST-2-1", 0.36, "ST-2"),
  unit(856, "ST-2", "integrada"),
  uso(890, "implementar", "implementar-ST-1-1", 0.42, "ST-1"),
  unit(914, "ST-1", "iniciada"),
  uso(1050, "implementar", "implementar-ST-1-2", 0.45, "ST-1"),
  unit(1051, "ST-1", "integrada"),
  unit(1075, "ST-3", "iniciada"),
  uso(1150, "implementar", "implementar-ST-3-1", 0.34, "ST-3"),
  unit(1151, "ST-3", "integrada"),
  ok(1153, "implementar"),
  start(1153, "verificar"),
  back(1165, "verificar", ["ST-1"], "AC-9 sigue en rojo"),
  { tipo: "autofix", at: at(1167), origen: "flowrunner", sha: null },
  start(1167, "verificar"),
  back(1177, "verificar", ["ST-1"], "AC-9 sigue en rojo"),
  start(1177, "implementar"),
  unit(1198, "ST-1", "iniciada"),
  uso(1256, "implementar", "implementar-ST-1-3", 0.22, "ST-1"),
  unit(1276, "ST-1", "iniciada"),
  uso(1322, "implementar", "implementar-ST-1-4", 0.18, "ST-1"),
  unit(1322, "ST-1", "fallida"),
  {
    tipo: "accion_terminada",
    at: at(1322),
    fase: "implementar",
    resultado: { tipo: "pregunta", motivo: "ST-1 no cambió ningún archivo", unidades: ["ST-1"] },
  },
  { tipo: "arreglo_manual", at: at(1467), sha: "abc1234" },
  start(1468, "verificar"),
  ok(1526, "verificar"),
  start(1526, "revisar"),
  uso(1702, "revisar", "revisar-1", 1.13),
  back(1702, "revisar", ["ST-3"], "bloqueante en servidor/conexion.ts:90"),
  { tipo: "autofix", at: at(1704), origen: "flowrunner", sha: "def5678" },
  start(1704, "verificar"),
  ok(1761, "verificar"),
  start(1761, "revisar"),
  uso(1951, "revisar", "revisar-2", 0.83),
  ok(1951, "revisar"),
  start(1951, "probar"),
  uso(2080, "probar", "probar-1", 0.28),
  {
    tipo: "accion_terminada",
    at: at(2080),
    fase: "probar",
    resultado: { tipo: "falla", clase: "sin_probar", motivo: "6 de 10 criterios sin probar" },
  },
  { tipo: "aceptado", at: at(2090), fase: "probar", motivo: "lo pruebo a mano", origen: "orca" },
  start(2090, "entregar"),
  { tipo: "pr", at: at(2106), url: "https://github.com/x/y/pull/12", numero: 12 },
  ok(2106, "entregar"),
];

export const tasks = [
  { id: "ST-1", titulo: "Generador con el claude instalado", depende_de: [] },
  { id: "ST-2", titulo: "Conexiones en el frontend", depende_de: [] },
  { id: "ST-3", titulo: "Estado de la conexión", depende_de: ["ST-1"] },
];

const node = (nombre: string, corriendo = false): SessionNode => ({
  nombre,
  modelo: "claude-sonnet-5-5",
  corriendo,
  costoUsd: corriendo ? undefined : 0.1,
  tokens: 1000,
  contexto: 0,
  ventana: undefined,
  costoEstimado: undefined,
  segundos: 10,
  pasos: 1,
  ultimo: undefined,
});
export const owned = (nombre: string, corriendo = false) => {
  const m = /^implementar-(ST-\d+)-\d+$/.exec(nombre);
  const fase = (m === null ? nombre.replace(/-\d+$/, "") : "implementar") as Phase;
  return { owner: { fase, unidad: m?.[1] }, node: node(nombre, corriendo) };
};
export const allSessions = [
  "planificar-1",
  "implementar-ST-2-1",
  "implementar-ST-1-1",
  "implementar-ST-1-2",
  "implementar-ST-3-1",
  "implementar-ST-1-3",
  "implementar-ST-1-4",
  "revisar-1",
  "revisar-2",
  "probar-1",
].map((n) => owned(n));

export const build = (events: readonly RunEvent[], status: RunStatus, sessions = allSessions) =>
  recorridoOf({ events, sessions, tasks, status, now: T0 + 1_400_000 });
