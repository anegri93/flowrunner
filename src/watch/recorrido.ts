// El recorrido de un run: lo que pasó, en orden, con las vueltas agrupadas. `watch` y el panel de
// Orca lo dibujan como una línea de tiempo (docs/specs/2026-11-12-recorrido.md). Función pura sobre
// los eventos: una pasada, porque `events.jsonl` ya está en el orden real.
import { TERMINAL, type RunStatus } from "../engine/engine.ts";
import { PHASES, type Phase, type RunEvent } from "../store/events.ts";
import type { SessionNode, UnitNode, UnitState } from "./tree.ts";

export type PasoResultado =
  | "ok"
  | "salteada"
  | "vuelve"
  | "falla"
  | "pregunta"
  | "pausa"
  | "espera"
  | "corriendo"
  | "cortada";

export type TuyoQue =
  | "aprobaste"
  | "pediste cambios"
  | "arreglaste a mano"
  | "pediste un arreglo"
  | "aceptaste"
  | "aceptaste sin probar"
  | "rehiciste"
  | "reanudaste"
  | "abortaste";

/** Una corrida de una etapa. `clave` es estable: sale del índice de su `accion_iniciada`. */
export interface PasoEtapa {
  readonly tipo: "etapa";
  readonly clave: string;
  readonly fase: Phase;
  readonly inicio: string;
  readonly segundos: number | undefined;
  readonly costoUsd: number;
  readonly resultado: PasoResultado;
  readonly motivo: string | undefined;
  /** A quién devolvió trabajo o a quién atribuye la pregunta. */
  readonly unidades: readonly string[];
  readonly pr: number | undefined;
  readonly sesiones: SessionNode[];
  /** Solo implementar: las sub-tasks que corrieron en esta corrida. */
  readonly subtareas: UnitNode[];
  readonly vuelta: number | undefined;
  readonly abierto: boolean;
  /** Cuántas corridas junta: los chequeos seguidos que esperan (el merge, cada 10 minutos) son uno. */
  readonly chequeos: number;
}

export type Paso =
  | PasoEtapa
  | {
      readonly tipo: "tuyo";
      readonly clave: string;
      readonly at: string;
      readonly que: TuyoQue;
      readonly detalle: string | undefined;
      readonly vuelta: number | undefined;
    }
  | {
      readonly tipo: "auto";
      readonly clave: string;
      readonly at: string;
      readonly que: "autofix";
      readonly vuelta: number | undefined;
    }
  | { readonly tipo: "pendiente"; readonly clave: string; readonly fases: readonly Phase[] };

/** Un tramo de vueltas: lo que pasó desde que una etapa devolvió trabajo hasta que quedó en verde. */
export interface Vuelta {
  readonly numero: number;
  readonly fase: Phase;
  /** Cómo la abrió su etapa: devolvió trabajo, falló o se detuvo a preguntar. */
  readonly resultado: "vuelve" | "falla" | "pregunta";
  /** Cuántas veces su etapa terminó en rojo dentro del tramo. */
  readonly veces: number;
  readonly unidades: readonly string[];
  readonly pasos: number;
  readonly segundos: number;
  readonly costoUsd: number;
  /** Su etapa todavía no quedó en verde ni el run siguió de largo. */
  readonly abierta: boolean;
  readonly abierto: boolean;
}

export interface RecorridoInput {
  readonly events: readonly RunEvent[];
  /** Las sesiones del run en orden de nacimiento, con la fase y la sub-task que las corrió. */
  readonly sessions: readonly {
    readonly owner: { readonly fase: Phase; readonly unidad: string | undefined } | undefined;
    readonly node: SessionNode;
  }[];
  readonly tasks: readonly { id: string; titulo: string; depende_de: readonly string[] }[];
  readonly status: RunStatus;
  /** Para el reloj de la corrida que sigue abierta. */
  readonly now: number;
}

const UNIT: Record<Extract<RunEvent, { tipo: "unidad" }>["estado"], UnitState> = {
  iniciada: "corriendo",
  commiteada: "commiteada",
  integrada: "integrada",
  fallida: "fallida",
  sin_cambios: "sin_cambios",
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface OpenEtapa extends Mutable<Omit<PasoEtapa, "sesiones" | "subtareas" | "abierto">> {
  /** El arranque de la corrida abierta; `inicio` es el de la primera que junta. */
  desde: string;
  /** Los segundos de las corridas anteriores que junta. */
  previos: number;
  readonly nombres: Set<string>;
  readonly unidadesCorridas: Map<string, UnitState>;
}

const RED = new Set(["vuelve", "falla", "pregunta"]);

export function recorridoOf(input: RecorridoInput): {
  recorrido: Paso[];
  vueltas: Vuelta[];
} {
  const { events, status } = input;
  const terminal = TERMINAL.has(status);
  const pasos: (OpenEtapa | Exclude<Paso, PasoEtapa | { tipo: "pendiente" }>)[] = [];
  const open = new Map<Phase, OpenEtapa>();
  const vueltas: Mutable<Vuelta>[] = [];
  let current: Mutable<Vuelta> | undefined;

  const closeVuelta = () => {
    if (current !== undefined) current.abierta = false;
    current = undefined;
  };
  const push = (p: (typeof pasos)[number]) => {
    pasos.push(p);
    if (current !== undefined && p.vuelta === current.numero) current.pasos += 1;
  };
  const mine = (clave: string, at: string, que: TuyoQue, detalle?: string) => {
    push({ tipo: "tuyo", clave, at, que, detalle, vuelta: current?.numero });
  };

  events.forEach((e, index) => {
    const clave = `p${String(index)}`;
    switch (e.tipo) {
      case "accion_iniciada": {
        // La etapa abierta de una vuelta quedó atrás: el run siguió a una fase posterior.
        if (current !== undefined && PHASES.indexOf(e.fase) > PHASES.indexOf(current.fase))
          closeVuelta();
        // Otro chequeo de lo que se esperaba (el merge): sigue el mismo paso, no una fila por chequeo.
        const prev = pasos.at(-1);
        if (prev?.tipo === "etapa" && prev.fase === e.fase && prev.resultado === "espera") {
          prev.chequeos += 1;
          prev.previos = prev.segundos ?? 0;
          prev.desde = e.at;
          prev.resultado = terminal ? "cortada" : "corriendo";
          open.set(e.fase, prev);
          return;
        }
        const paso: OpenEtapa = {
          tipo: "etapa",
          clave,
          fase: e.fase,
          inicio: e.at,
          segundos: undefined,
          costoUsd: 0,
          resultado: terminal ? "cortada" : "corriendo",
          motivo: undefined,
          unidades: [],
          pr: undefined,
          vuelta: current?.numero,
          chequeos: 1,
          desde: e.at,
          previos: 0,
          nombres: new Set(),
          unidadesCorridas: new Map(),
        };
        open.set(e.fase, paso);
        push(paso);
        return;
      }
      case "accion_terminada": {
        const paso = open.get(e.fase);
        if (paso === undefined) return;
        open.delete(e.fase);
        const r = e.resultado;
        paso.segundos =
          paso.previos + Math.round((Date.parse(e.at) - Date.parse(paso.desde)) / 1000);
        paso.resultado =
          r.tipo === "ok"
            ? r.salteada === undefined
              ? "ok"
              : "salteada"
            : r.tipo === "limite"
              ? "pausa"
              : r.tipo;
        if (r.tipo === "ok" && r.salteada !== undefined) paso.motivo = r.salteada;
        if (r.tipo === "falla" || r.tipo === "vuelve" || r.tipo === "pregunta")
          paso.motivo = r.motivo;
        if (r.tipo === "vuelve" || r.tipo === "pregunta") paso.unidades = r.unidades ?? [];
        if (RED.has(paso.resultado)) {
          if (current === undefined) {
            current = {
              numero: vueltas.length + 1,
              fase: e.fase,
              resultado: paso.resultado as Vuelta["resultado"],
              veces: 0,
              unidades: [],
              pasos: 1,
              segundos: 0,
              costoUsd: 0,
              abierta: true,
              abierto: false,
            };
            vueltas.push(current);
            paso.vuelta = current.numero;
          }
          if (current.fase === e.fase) {
            current.veces += 1;
            current.unidades = [...new Set([...current.unidades, ...paso.unidades])];
          }
        } else if (r.tipo === "ok" && current?.fase === e.fase && paso.vuelta === current.numero) {
          // La etapa que abrió la vuelta quedó en verde: este paso ya es el camino de vuelta.
          paso.vuelta = undefined;
          current.pasos -= 1;
          closeVuelta();
        }
        return;
      }
      case "uso": {
        const paso = open.get(e.fase);
        if (paso === undefined) return;
        paso.costoUsd += e.costo_usd;
        paso.nombres.add(e.sesion);
        return;
      }
      case "unidad": {
        const paso = open.get(e.fase);
        // Cortada por la red no es fallida: el engine la reintenta.
        paso?.unidadesCorridas.set(e.unidad, e.corte_de_red === true ? "cortada" : UNIT[e.estado]);
        return;
      }
      case "pr": {
        const paso = pasos.findLast(
          (p): p is OpenEtapa => p.tipo === "etapa" && p.fase === "entregar",
        );
        if (paso !== undefined) paso.pr = e.numero;
        return;
      }
      case "aprobado":
      case "cambios_pedidos": {
        // Tu respuesta reemplaza a aprobar esperando, en el mismo lugar: las claves no se corren.
        const at = pasos.findLastIndex(
          (p) => p.tipo === "etapa" && p.fase === "aprobar" && p.resultado === "espera",
        );
        const tuyo = {
          tipo: "tuyo" as const,
          clave: at === -1 ? clave : (pasos[at]?.clave ?? clave),
          at: e.at,
          que: e.tipo === "aprobado" ? ("aprobaste" as const) : ("pediste cambios" as const),
          detalle: e.tipo === "cambios_pedidos" ? e.motivo : undefined,
          vuelta: current?.numero,
        };
        if (at === -1) push(tuyo);
        else pasos[at] = tuyo;
        return;
      }
      case "autofix":
        push({ tipo: "auto", clave, at: e.at, que: "autofix", vuelta: current?.numero });
        return;
      case "arreglo_manual":
        mine(clave, e.at, "arreglaste a mano", e.sha?.slice(0, 7));
        return;
      case "arreglo_pedido":
        mine(clave, e.at, "pediste un arreglo", `${e.unidades.join(", ")}: ${e.instruccion}`);
        return;
      case "aceptado":
        mine(clave, e.at, "aceptaste", e.motivo);
        return;
      case "sin_probar_aceptado":
        mine(clave, e.at, "aceptaste sin probar", e.motivo);
        return;
      case "rehacer":
        mine(clave, e.at, "rehiciste", `desde ${e.desde}`);
        closeVuelta();
        return;
      case "reanudado":
        mine(clave, e.at, "reanudaste");
        return;
      case "abortado":
        mine(clave, e.at, "abortaste");
        return;
      default:
        return;
    }
  });

  // Las sesiones van a la corrida en la que cayó su `uso`; la que todavía no tiene, a la última
  // corrida de su fase.
  const etapas = pasos.filter((p): p is OpenEtapa => p.tipo === "etapa");
  const ownerOf = new Map<string, OpenEtapa>();
  for (const p of etapas) for (const n of p.nombres) ownerOf.set(n, p);
  const sesionesDe = new Map<OpenEtapa, RecorridoInput["sessions"][number][]>();
  for (const s of input.sessions) {
    const fase = s.owner?.fase;
    const paso =
      ownerOf.get(s.node.nombre) ??
      (fase === undefined ? undefined : etapas.findLast((p) => p.fase === fase));
    if (paso === undefined) continue;
    sesionesDe.set(paso, [...(sesionesDe.get(paso) ?? []), s]);
  }

  const lastEtapa = etapas.at(-1);
  const recorrido: Paso[] = pasos.map((p): Paso => {
    if (p.tipo !== "etapa") return p;
    const { nombres: _n, unidadesCorridas, desde, previos, ...rest } = p;
    const own = sesionesDe.get(p) ?? [];
    const subtareas =
      p.fase === "implementar"
        ? input.tasks
            .filter((t) => unidadesCorridas.has(t.id))
            .map((t): UnitNode => {
              const sesiones = own.filter((s) => s.owner?.unidad === t.id).map((s) => s.node);
              const estado = unidadesCorridas.get(t.id) ?? "pendiente";
              return {
                id: t.id,
                titulo: t.titulo,
                estado: sesiones.some((s) => s.corriendo)
                  ? "corriendo"
                  : estado === "corriendo" && (terminal || p.resultado !== "corriendo")
                    ? "cortada"
                    : estado,
                dependeDe: [...t.depende_de],
                sesiones,
              };
            })
        : [];
    return {
      ...rest,
      segundos:
        p.resultado === "corriendo"
          ? previos + Math.max(0, Math.round((input.now - Date.parse(desde)) / 1000))
          : p.segundos,
      sesiones: p.fase === "implementar" ? [] : own.map((s) => s.node),
      subtareas,
      abierto: p.resultado === "corriendo" || (status === "detenido" && p === lastEtapa),
    };
  });

  for (const v of vueltas) {
    const mios = recorrido.filter(
      (p): p is PasoEtapa => p.tipo === "etapa" && p.vuelta === v.numero,
    );
    v.segundos = mios.reduce((a, p) => a + (p.segundos ?? 0), 0);
    v.costoUsd = mios.reduce((a, p) => a + p.costoUsd, 0);
    v.abierto = v.abierta && !terminal;
  }

  if (!terminal) {
    const from = lastEtapa === undefined ? 0 : PHASES.indexOf(lastEtapa.fase) + 1;
    const fases = PHASES.slice(from);
    if (fases.length > 0) recorrido.push({ tipo: "pendiente", clave: "pendiente", fases });
  }
  return { recorrido, vueltas };
}
