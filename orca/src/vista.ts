// La pestaña de los runs como HTML, sin DOM ni Orca: cada run es una tarjeta con su estado, el
// título, el tiempo y las nueve etapas en lista, cada una con su indicador; debajo de la actual, qué
// hace, sus sub-tasks y las decisiones que espera. Los terminados muestran solo la etapa actual hasta
// que se abren. Debajo, los últimos cerrados, compactos y colapsados.
//
// Cada control es un <button> con su acción en `data-accion` (JSON): `frame.ts` la lee al tocarlo y
// se la pasa al panel. Todo texto que viene de flowrunner pasa por `esc`.
import { indicador, indicadorDeEtapa, indicadorDeTarea, INDICADORES_CSS } from "./indicadores";
import type { Openable, Snapshot } from "./protocol";
import {
  canAbort,
  clock,
  closedSummary,
  decisionsFor,
  describeExisting,
  existingChanges,
  fixUnits,
  isFinished,
  needsYou,
  nowOf,
  planVersion,
  rerunPhase,
  runChip,
  suggestedFixes,
  sortRuns,
  stageRows,
  tail,
  type Decision,
  type Run,
  type StageRow,
  type Tone,
} from "./runs";

/** Lo que la persona toca. `frame.ts` la manda al panel tal cual. */
export type Accion =
  | { readonly t: "alternar"; readonly run: string }
  | { readonly t: "cerrados" }
  | { readonly t: "alternarCerrado"; readonly run: string }
  | { readonly t: "abrir"; readonly run: string; readonly que: Openable }
  | { readonly t: "externo"; readonly url: string }
  | { readonly t: "preguntar"; readonly run: string; readonly decision: Decision }
  | { readonly t: "decidir"; readonly run: string; readonly decision: Decision }
  | { readonly t: "cancelar" }
  | { readonly t: "enviarTexto"; readonly run: string }
  | { readonly t: "abortar"; readonly run: string }
  | { readonly t: "noAbortar" }
  | { readonly t: "confirmarAbortar"; readonly run: string };

/** Todo lo que se ve. Lo arma y lo cambia `Panel` (estado.ts). */
export interface Estado {
  readonly snapshot: Snapshot | null;
  /** Runs que la persona abrió o cerró a mano; el resto sigue el default. */
  readonly abiertos: Readonly<Record<string, boolean>>;
  /** El plan que la persona abrió en Orca, por run: Aprobar se habilita recién con el plan visto. */
  readonly planesVistos: Readonly<Record<string, string>>;
  /** La sección de los cerrados y sus filas desplegadas. */
  readonly cerradosAbiertos: boolean;
  readonly cerradoAbierto: Readonly<Record<string, boolean>>;
  /** Por qué no se pudo abrir algo, en su run. */
  readonly aviso: { readonly run: string; readonly texto: string } | null;
  /** La decisión que espera confirmación, o el texto que se está escribiendo. */
  readonly pendiente: { readonly run: string; readonly decision: Decision } | null;
  readonly borrador: string;
  /** Lo que dijo flowrunner al decidir: lo que no salió, y lo que dijo al aprender o al dar la ruta. */
  readonly dicho: { readonly run: string; readonly ok: boolean; readonly mensaje: string } | null;
  readonly enviando: string | null;
  readonly abortando: string | null;
  readonly avisoAbortar: { readonly run: string; readonly mensaje: string } | null;
  /** Para la fase de las animaciones: `Date.now()` al dibujar. */
  readonly ahora: number;
}

export const ESTADO_INICIAL: Estado = {
  snapshot: null,
  abiertos: {},
  planesVistos: {},
  cerradosAbiertos: false,
  cerradoAbierto: {},
  aviso: null,
  pendiente: null,
  borrador: "",
  dicho: null,
  enviando: null,
  abortando: null,
  avisoAbortar: null,
  ahora: 0,
};

/** El id del campo de texto: `frame.ts` le devuelve el foco después de redibujar. */
export const CAMPO = "fr-texto";

export const esc = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const planSeen = (e: Estado, run: Run): boolean =>
  e.planesVistos[run.id] === planVersion(run);

export const isOpen = (e: Estado, run: Run): boolean =>
  e.abiertos[run.id] ?? (needsYou(run) || !isFinished(run));

// --- Piezas --------------------------------------------------------------------------------

interface BotonOpts {
  readonly clase?: string;
  readonly label?: string;
  readonly disabled?: boolean;
}

function boton(accion: Accion, contenido: string, o: BotonOpts = {}): string {
  return `<button type="button" class="${o.clase ?? "btn"}" data-accion="${esc(JSON.stringify(accion))}"${o.label === undefined ? "" : ` aria-label="${esc(o.label)}" title="${esc(o.label)}"`}${o.disabled === true ? " disabled" : ""}>${contenido}</button>`;
}

const texto = (t: string, clase = "", tone?: Tone) =>
  `<span class="${[clase, tone === undefined ? "" : `t-${tone}`].filter((c) => c !== "").join(" ")}">${esc(t)}</span>`;

const ICONO_DOC = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2H4.5v12h7V4z"/><path d="M9.5 2v2h2M6.5 8h3M6.5 10.5h3"/></svg>`;
const flecha = (abierta: boolean) =>
  `<svg class="flecha${abierta ? " abierta" : ""}" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>`;

// --- Decisiones ----------------------------------------------------------------------------

/** Las decisiones que se mandan con un texto de la persona: qué escribe y cómo se arma la decisión. */
export function textFor(
  decision: Decision | undefined,
): { label: string; placeholder: string; decision: (text: string) => Decision } | undefined {
  switch (decision?.accion) {
    case "cambios":
      return {
        label: "Qué cambiar del plan",
        placeholder: "Qué corregir y qué mantener",
        decision: (motivo) => ({ accion: "cambios", motivo }),
      };
    case "arreglar": {
      const unidad = decision.unidad;
      return {
        label: `Qué tiene que corregir ${unidad}`,
        placeholder: "Qué está mal y qué tiene que quedar",
        decision: (instruccion) => ({ accion: "arreglar", unidad, instruccion }),
      };
    }
    case "aceptar":
      return {
        label: "Por qué seguir así; queda en la PR",
        placeholder: "Por qué este rojo no frena la entrega",
        decision: (motivo) => ({ accion: "aceptar", motivo }),
      };
    default:
      return undefined;
  }
}

/**
 * La decisión a medio confirmar de este run, si vale todavía. Un Aprobar vale solo para el plan sobre
 * el que se tocó, y abierto: no para el de un replan que llegó mientras tanto, aunque después se abra.
 */
export function pendingFor(e: Estado, run: Run): Decision | undefined {
  const waiting = e.pendiente;
  if (waiting?.run !== run.id) return undefined;
  if (waiting.decision.accion !== "aprobar") return waiting.decision;
  return waiting.decision.plan === planVersion(run) && planSeen(e, run)
    ? waiting.decision
    : undefined;
}

const enviando = (etiqueta: string, ahora: number) =>
  `<div class="fila">${indicador("tarea-corriendo", "accent", ahora)}${texto(etiqueta, "chico")}</div>`;

function decisiones(e: Estado, run: Run): string {
  const offered = decisionsFor(run);
  const mine = pendingFor(e, run);
  const note =
    e.dicho?.run === run.id
      ? texto(e.dicho.mensaje, "nota", e.dicho.ok ? "success" : "danger")
      : "";
  if (e.enviando === run.id) return enviando("Enviando tu decisión", e.ahora);
  if (offered.length === 0) return note;
  const cancelar = boton({ t: "cancelar" }, "Cancelar", { clase: "btn ghost" });
  const asked = textFor(mine);
  if (asked !== undefined) {
    return `<div class="pila"><input id="${CAMPO}" class="campo" aria-label="${esc(asked.label)}" placeholder="${esc(asked.placeholder)}" value="${esc(e.borrador)}" data-enviar="${esc(JSON.stringify({ t: "enviarTexto", run: run.id }))}"><div class="botones">${boton({ t: "enviarTexto", run: run.id }, "Enviar", { clase: "btn solid accent", disabled: e.borrador.trim() === "" })}${cancelar}</div></div>`;
  }
  const existing = existingChanges(run);
  if (mine?.accion === "aprobar" && existing.length > 0) {
    // Aprobar un plan que cambia lo que ya existe es aceptar esos cambios: se ven antes del botón.
    return `<div class="pila">${texto(`⚠ El plan cambia lo que ya existe (${String(existing.length)})`, "fuerte", "warning")}${existing.map((c) => texto(`• ${describeExisting(c)}`, "chico")).join("")}${texto("Aprobar es aceptar estos cambios. Si alguno no va, cancelá y pedí cambios.", "chico apagado")}<div class="botones">${boton({ t: "decidir", run: run.id, decision: { accion: "aprobar", plan: mine.plan, aceptoCambios: true } }, "Acepto los cambios y apruebo", { clase: "btn solid warning" })}${cancelar}</div></div>`;
  }
  if (mine !== undefined) {
    const question =
      mine.accion === "aprobar"
        ? "¿Aprobar el plan? Arranca implementar."
        : mine.accion === "reanudar"
          ? `¿Reanudar ${run.clave}?`
          : mine.accion === "autofix"
            ? `¿Autofix en ${run.clave}? Pasa el formateador y el lint y vuelve a verificar; si sigue en rojo, las sub-tasks lo corrigen solas.`
            : `¿Rehacer ${run.clave} desde ${mine.accion === "rehacer" ? mine.desde : ""}?`;
    return `<div class="pila">${texto(question, "fuerte")}<div class="botones">${boton({ t: "decidir", run: run.id, decision: mine }, "Sí, confirmar", { clase: "btn solid success" })}${cancelar}</div></div>`;
  }
  const ask = (decision: Decision): Accion => ({ t: "preguntar", run: run.id, decision });
  const seen = planSeen(e, run);
  const desde = rerunPhase(run);
  const units = offered.includes("arreglar") ? fixUnits(run) : [];
  // El arreglo ya escrito se elige con un toque: elegirlo es la confirmación, como en el CLI.
  const suggested = offered.includes("arreglar")
    ? suggestedFixes(run).map((a) =>
        boton(
          { t: "decidir", run: run.id, decision: { accion: "arreglar", ...a } },
          `${esc(a.unidad)} · ${esc(a.instruccion)}`,
          { clase: "btn arreglo" },
        ),
      )
    : [];
  const botones = [
    offered.includes("aprender")
      ? boton({ t: "decidir", run: run.id, decision: { accion: "aprender" } }, "Aprender ahora")
      : "",
    offered.includes("aprobar")
      ? boton(ask({ accion: "aprobar", plan: planVersion(run) }), "Aprobar", {
          clase: "btn solid success",
          disabled: !seen,
        })
      : "",
    offered.includes("cambios") ? boton(ask({ accion: "cambios", motivo: "" }), "Cambios") : "",
    run.status === "esperando_aprobacion"
      ? boton({ t: "abrir", run: run.id, que: { tipo: "plan" } }, "Plan", { clase: "btn ghost" })
      : "",
    ...units.map((unidad) =>
      boton(ask({ accion: "arreglar", unidad, instruccion: "" }), `Arreglar ${unidad}`),
    ),
    offered.includes("autofix") ? boton(ask({ accion: "autofix" }), "Autofix") : "",
    offered.includes("aceptar")
      ? boton(ask({ accion: "aceptar", motivo: "" }), "Seguir igual")
      : "",
    offered.includes("reanudar") ? boton(ask({ accion: "reanudar" }), "Reanudar") : "",
    offered.includes("rehacer") && desde !== undefined
      ? boton(ask({ accion: "rehacer", desde }), `Rehacer desde ${desde}`)
      : "",
  ].join("");
  return `<div class="pila">${note}${
    run.status === "detenido" && run.unidades !== undefined && run.unidades.length > 0
      ? texto(`Parece ser de: ${run.unidades.join(", ")}`, "chico apagado")
      : ""
  }${
    offered.includes("aprobar") && existing.length > 0
      ? texto(
          `⚠ El plan cambia lo que ya existe (${String(existing.length)}): miralo antes de aprobar.`,
          "chico",
          "warning",
        )
      : ""
  }${
    suggested.length === 0 ? "" : `<div class="pila">${suggested.join("")}</div>`
  }<div class="botones">${botones}</div>${
    offered.includes("aprobar") && !seen
      ? texto("Abrí el plan para poder aprobar.", "chico apagado")
      : ""
  }</div>`;
}

/** Abortar el run entero, al pie de su tarjeta: no es una decisión de la etapa actual. */
function abortar(e: Estado, run: Run): string {
  if (!canAbort(run)) return "";
  if (e.enviando === run.id) return enviando(`Abortando el run ${run.clave}`, e.ahora);
  if (e.abortando === run.id) {
    return `<div class="sep"></div><div class="pila">${texto(`¿Abortar el run ${run.clave}?`, "fuerte")}${texto("Corta lo que esté corriendo, en cualquier etapa, y borra sus worktrees. La rama y la PR quedan.", "chico apagado")}<div class="botones fin">${boton({ t: "confirmarAbortar", run: run.id }, "Sí, abortar el run", { clase: "btn solid danger" })}${boton({ t: "noAbortar" }, "Cancelar", { clase: "btn ghost" })}</div></div>`;
  }
  const note =
    e.avisoAbortar?.run === run.id ? texto(e.avisoAbortar.mensaje, "chico", "danger") : "";
  return `<div class="sep"></div>${note}<div class="botones fin">${boton({ t: "abortar", run: run.id }, "Abortar el run", { clase: "btn ghost danger" })}</div>`;
}

// --- Etapas --------------------------------------------------------------------------------

/** Lo que pasa en la etapa actual: el motivo, las sub-tasks, qué hace la sesión y las decisiones. */
function actual(e: Estado, run: Run): string {
  const now = nowOf(run);
  const motivo = run.motivo === undefined ? "" : texto(tail(run.motivo, 600), "chico", "danger");
  const detalle =
    now.detalle === undefined || run.motivo !== undefined
      ? ""
      : texto(
          now.detalle.length > 280 ? `${now.detalle.slice(0, 280)}…` : now.detalle,
          "chico",
          "warning",
        );
  const tareas = now.tareas
    .map(
      (t) =>
        `<div class="fila tarea">${indicador(indicadorDeTarea(t.estado), t.tone, e.ahora)}${boton({ t: "abrir", run: run.id, que: { tipo: "unidad", unidad: t.key } }, esc(t.texto), { clase: `lnk corta${t.tone === "neutral" ? " apagado" : ""}` })}</div>`,
    )
    .join("");
  const actividad = now.actividad
    .map(
      (a) =>
        `<div class="fila entre">${texto(a.ahora ?? a.texto, `chico corta${a.ahora === undefined ? " apagado" : ""}`, a.ahora === undefined ? undefined : "accent")}${boton({ t: "abrir", run: run.id, que: { tipo: "pasos", sesion: a.sesion } }, ICONO_DOC, { clase: "icono", label: `Pasos de ${a.sesion}` })}</div>`,
    )
    .join("");
  const aviso = e.aviso?.run === run.id ? texto(e.aviso.texto, "chico", "danger") : "";
  return `<div class="actual">${motivo}${detalle}${tareas}${actividad}${decisionsFor(run).length > 0 ? decisiones(e, run) : ""}${aviso}</div>`;
}

/** El run ya tiene plan: planificar terminó, aunque después se haya aprobado o corregido. */
const hasPlan = (run: Run) => run.fases.some((p) => p.fase === "planificar" && p.estado === "ok");

/** Una etapa: su indicador, su nombre, su estado si no está lista ni pendiente, sus intentos y su tiempo. */
function etapa(e: Estado, run: Run, row: StageRow): string {
  const pending = row.estado === "pendiente";
  const clave = indicadorDeEtapa(row.fase, row.estado, run.prMergeada === true);
  const ind = indicador(clave, row.tone, e.ahora, `${row.nombre}: ${row.texto}`);
  const nombre =
    row.fase === "aprobar" && hasPlan(run)
      ? boton({ t: "abrir", run: run.id, que: { tipo: "plan" } }, esc(row.nombre), { clase: "lnk" })
      : pending
        ? texto(row.nombre, "apagado")
        : boton(
            { t: "abrir", run: run.id, que: { tipo: "etapa", fase: row.fase } },
            esc(row.nombre),
            {
              clase: `lnk${row.actual ? " fuerte" : ""}`,
            },
          );
  return `<div class="etapa${row.actual ? " es-actual" : ""}"><div class="fila entre"><div class="fila">${ind}${nombre}${row.estado === "ok" || pending ? "" : texto(row.texto, "chico", row.tone)}</div>${texto(row.meta, "chico apagado num")}</div>${row.actual ? actual(e, run) : ""}</div>`;
}

function tarjeta(e: Estado, run: Run): string {
  const open = isOpen(e, run);
  const chip = runChip(run);
  const rows = stageRows(run);
  const shown = open ? rows : rows.filter((r) => r.actual);
  const pr = run.siguiente?.startsWith("https://") === true ? run.siguiente : undefined;
  return `<article class="tarjeta"><div class="fila entre"><span class="chip t-${chip.tone}">${esc(chip.texto)}</span>${boton({ t: "alternar", run: run.id }, flecha(open), { clase: "icono", label: open ? `Ocultar las etapas de ${run.clave}` : `Ver las etapas de ${run.clave}` })}</div><div><div class="titulo">${esc(run.titulo)}</div>${texto(`${run.clave} · ${run.id}`, "chico apagado")}</div><div><div class="rotulo">TIEMPO</div><div class="tiempo num">${esc(clock(run.segundos) ?? "–")}</div></div><div class="sep"></div>${shown.map((row) => etapa(e, run, row)).join("")}<div class="fila entre">${pr === undefined ? "<span></span>" : boton({ t: "externo", url: pr }, "Abrir la PR", { clase: "lnk acento" })}${texto(nowOf(run).meta, "chico apagado num")}</div>${abortar(e, run)}</article>`;
}

/** Un run cerrado, compacto: cómo terminó, `CLAVE · título` que abre su informe, y su resumen. */
function cerrado(e: Estado, run: Run): string {
  const expanded = e.cerradoAbierto[run.id] === true;
  const aborted = run.status === "abortado";
  const ran = stageRows(run).filter((r) => r.estado !== "pendiente");
  return `<div class="cerrado"><div class="fila entre"><div class="fila">${indicador(aborted ? "cortada" : "ok", aborted ? "neutral" : "success", e.ahora)}<div class="pila corta">${boton({ t: "abrir", run: run.id, que: { tipo: "informe" } }, esc(`${run.clave} · ${run.titulo}`), { clase: "lnk corta" })}${texto(closedSummary(run), "chico apagado corta")}</div></div>${boton({ t: "alternarCerrado", run: run.id }, flecha(expanded), { clase: "icono", label: expanded ? `Ocultar las etapas de ${run.clave}` : `Ver las etapas de ${run.clave}` })}</div>${expanded ? `<div class="pila">${ran.map((row) => etapa(e, run, row)).join("")}</div>` : ""}</div>`;
}

function cerrados(e: Estado, runs: readonly Run[]): string {
  if (runs.length === 0) return "";
  const open = e.cerradosAbiertos;
  return `<div class="sep"></div><div class="fila entre">${texto(`CERRADOS · ${String(runs.length)}`, "rotulo")}${boton({ t: "cerrados" }, flecha(open), { clase: "icono", label: open ? "Ocultar los runs cerrados" : "Ver los runs cerrados" })}</div>${open ? runs.map((r) => cerrado(e, r)).join("") : ""}`;
}

/** La pestaña entera. Antes de la primera lectura, la nave en camino. */
export function vista(e: Estado): string {
  const snap = e.snapshot;
  if (snap === null) {
    return `<div class="leyendo"><img src="../assets/nave.png" alt="" width="96" height="96"><div class="fila">${indicador("preparar", "accent", e.ahora)}${texto("Leyendo los runs…", "apagado")}</div></div>`;
  }
  const runs = sortRuns(snap.runs);
  const others = snap.otros ?? 0;
  const elsewhere =
    others === 0
      ? null
      : `${String(others)} ${others === 1 ? "run activo" : "runs activos"} en otros proyectos: cambiá de proyecto en Orca para ${others === 1 ? "verlo" : "verlos"}.`;
  const proyecto = snap.proyecto === undefined ? "" : texto(snap.proyecto, "chico apagado");
  const error =
    snap.error === undefined
      ? ""
      : texto(`No se pudo leer flowrunner: ${snap.error}`, "chico", "danger");
  const cuerpo =
    runs.length === 0 && snap.error === undefined
      ? `<div class="vacio"><div class="fuerte">${esc(snap.proyecto === undefined ? "No hay runs activos" : `No hay runs activos en ${snap.proyecto}`)}</div>${texto(elsewhere ?? "Cuando lances una feature desde Claude Code, su progreso aparece acá.", "chico apagado")}</div>`
      : runs.map((r) => tarjeta(e, r)).join("");
  const resto = runs.length > 0 && elsewhere !== null ? texto(elsewhere, "chico apagado") : "";
  return `<div class="panel">${proyecto}${error}${cuerpo}${resto}${cerrados(e, snap.cerrados ?? [])}</div>`;
}

/** El estilo de la pestaña, con los tokens del tema de Orca. success y warning no vienen: van acá. */
export const PANEL_CSS = `
:root { color-scheme: light dark; --fr-success: #16a34a; --fr-warning: #d97706; --fr-danger: var(--orca-destructive, #dc2626); --fr-accent: #2563eb; --fr-muted: var(--orca-muted-foreground, #71717a); }
html.dark { --fr-success: #4ade80; --fr-warning: #fbbf24; --fr-accent: #60a5fa; }
* { box-sizing: border-box; }
body { margin: 0; padding: 10px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: var(--orca-foreground); background: var(--orca-background); }
.panel, .pila, .tarjeta, .actual { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.panel { gap: 12px; }
.tarjeta { gap: 10px; padding: 12px; border: 1px solid var(--orca-border); border-radius: var(--orca-radius, 8px); background: var(--orca-card, transparent); }
.fila { display: flex; align-items: center; gap: 8px; min-width: 0; }
.fila.entre { justify-content: space-between; }
.etapa { display: flex; flex-direction: column; gap: 6px; }
.actual { padding-left: 24px; }
.tarea { gap: 6px; }
.tarea .fr-i { width: 14px; height: 14px; }
.sep { border-top: 1px solid var(--orca-border); }
.titulo { font-weight: 600; font-size: 14px; }
.rotulo { font-size: 10.5px; letter-spacing: .06em; color: var(--fr-muted); }
.tiempo { font-weight: 600; font-size: 15px; }
.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.chico { font-size: 11.5px; }
.fuerte { font-weight: 600; }
.apagado { color: var(--fr-muted); }
.corta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.nota { font-size: 12px; }
.chip { font-size: 10.5px; font-weight: 600; letter-spacing: .05em; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, currentColor 14%, transparent); }
.t-accent { color: var(--fr-accent); } .t-success { color: var(--fr-success); } .t-warning { color: var(--fr-warning); } .t-danger { color: var(--fr-danger); } .t-neutral { color: var(--fr-muted); }
button { font: inherit; color: inherit; cursor: pointer; }
button:disabled { cursor: default; opacity: .45; }
button:focus-visible, .campo:focus-visible { outline: 2px solid var(--orca-ring, var(--fr-accent)); outline-offset: 1px; }
.lnk { background: none; border: 0; padding: 0; text-align: left; }
.lnk:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 2px; }
.lnk.acento { color: var(--fr-accent); font-size: 12px; }
.icono { display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--fr-muted); flex: none; }
.icono:hover { background: color-mix(in srgb, currentColor 14%, transparent); color: var(--orca-foreground); }
.flecha { transition: transform .15s ease; transform: rotate(90deg); }
.flecha.abierta { transform: rotate(-90deg); }
.botones { display: flex; flex-wrap: wrap; gap: 6px; }
.botones.fin { justify-content: flex-end; }
.btn { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--orca-border); background: var(--orca-secondary, transparent); color: var(--orca-secondary-foreground, inherit); }
.btn:hover:not(:disabled) { border-color: var(--fr-muted); }
.btn.ghost { background: none; border-color: transparent; }
.btn.arreglo { text-align: left; width: 100%; }
.btn.solid { border-color: transparent; color: #fff; }
.btn.solid.success { background: var(--fr-success); } .btn.solid.warning { background: var(--fr-warning); } .btn.solid.danger { background: var(--fr-danger); } .btn.solid.accent { background: var(--fr-accent); }
html.dark .btn.solid { color: #0b0b0b; }
.btn.danger:not(.solid) { color: var(--fr-danger); }
.campo { width: 100%; font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--orca-input, var(--orca-border)); background: transparent; color: inherit; }
.cerrado { display: flex; flex-direction: column; gap: 6px; }
.vacio { display: flex; flex-direction: column; gap: 4px; align-items: center; text-align: center; padding: 24px 8px; }
.leyendo { display: flex; flex-direction: column; align-items: center; gap: 10px; padding-top: 32px; }
@media (prefers-reduced-motion: reduce) { .flecha { transition: none; } }
${INDICADORES_CSS}`;
