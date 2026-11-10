// Los indicadores de estado del panel: un SVG chico por estado, y por etapa cuando trabaja, para que
// se lea de un vistazo qué hace cada una. Los que se mueven son lo vivo (trabaja, te espera, en pausa,
// volvió); lo terminado y lo pendiente quedan quietos. Sin imports de Orca ni DOM: devuelve texto.
//
// El panel se redibuja cada 3 s y una animación CSS arranca de cero con cada redibujo. Cada
// indicador animado lleva un `animation-delay` negativo, la fase de su ciclo en este momento, así
// sigue donde iba en vez de saltar.
import type { Tone } from "./runs";

export type Indicador =
  | "pendiente"
  | "ok"
  | "preparar"
  | "planificar"
  | "implementar"
  | "verificar"
  | "revisar"
  | "probar"
  | "entregar"
  | "aprender"
  | "te-espera"
  | "espera-merge"
  | "aprende-chequeo"
  | "pausa"
  | "vuelve"
  | "falla"
  | "cortada"
  | "tarea-pendiente"
  | "tarea-corriendo"
  | "tarea-lista"
  | "tarea-falla";

/** El ciclo de cada indicador animado, en ms; los que no están quedan quietos. */
export const PERIODO: Partial<Record<Indicador, number>> = {
  preparar: 900,
  planificar: 1200,
  implementar: 1000,
  verificar: 1600,
  revisar: 1800,
  probar: 1400,
  entregar: 1300,
  aprender: 2400,
  "te-espera": 2200,
  "espera-merge": 3000,
  "aprende-chequeo": 4000,
  pausa: 1800,
  vuelve: 2400,
  "tarea-corriendo": 900,
};

const RUNNING: Record<string, Indicador> = {
  preparar: "preparar",
  planificar: "planificar",
  implementar: "implementar",
  verificar: "verificar",
  revisar: "revisar",
  probar: "probar",
  entregar: "entregar",
  aprender: "aprender",
};

/** El indicador de una etapa: su estado y, si trabaja o espera, qué etapa es. */
export function indicadorDeEtapa(fase: string, estado: string, prMergeada = false): Indicador {
  switch (estado) {
    case "ok":
      return "ok";
    case "corriendo":
      return RUNNING[fase] ?? "preparar";
    case "espera":
      return fase === "aprobar" ? "te-espera" : prMergeada ? "aprende-chequeo" : "espera-merge";
    case "pausa":
      return "pausa";
    case "vuelve":
      return "vuelve";
    case "falla":
      return "falla";
    case "cortada":
    case "salteada":
      return "cortada";
    default:
      return "pendiente";
  }
}

/** El indicador de una sub-task, de su estado en `flowrunner watch`. */
export function indicadorDeTarea(estado: string): Indicador {
  switch (estado) {
    case "corriendo":
      return "tarea-corriendo";
    case "commiteada":
    case "integrada":
    case "sin_cambios":
      return "tarea-lista";
    case "fallida":
      return "tarea-falla";
    case "cortada":
      return "cortada";
    default:
      return "tarea-pendiente";
  }
}

/** Lo que dibuja cada indicador, en un lienzo de 16×16 con trazo redondo de 1,5. */
const DIBUJO: Record<Indicador, string> = {
  pendiente: `<circle cx="8" cy="8" r="5.5" stroke-dasharray="2 2.32" opacity=".55"/>`,
  ok: `<path d="M3.8 8.4l2.7 2.7L12.2 5.4"/>`,
  preparar: `<circle cx="8" cy="8" r="5.5" opacity=".2"/><path class="g" d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/>`,
  planificar: [3.5, 8, 12.5]
    .map(
      (x, i) =>
        `<circle class="g d${String(i)}" cx="${String(x)}" cy="8" r="1.5" fill="currentColor" stroke="none"/>`,
    )
    .join(""),
  implementar: [3, 7, 11]
    .map(
      (x, i) =>
        `<rect class="g d${String(i)}" x="${String(x)}" y="3" width="2" height="10" rx="1" fill="currentColor" stroke="none"/>`,
    )
    .join(""),
  verificar: `<circle cx="8" cy="8" r="6" opacity=".2"/><path class="g" pathLength="10" d="M4.8 8.3l2.2 2.2 4.2-4.6"/>`,
  revisar: `<g class="g"><circle cx="7" cy="7" r="3.6"/><path d="M9.7 9.7l3 3"/></g>`,
  probar: `<circle class="g" cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>`,
  entregar: `<path d="M3 10.5v2h10v-2" opacity=".55"/><path class="g" d="M8 10V3.5M5.5 6L8 3.5 10.5 6"/>`,
  aprender: `<circle cx="8" cy="8" r="5.5" opacity=".2"/><g class="g"><circle cx="8" cy="2.5" r="1.6" fill="currentColor" stroke="none"/></g>`,
  "te-espera": `<circle class="g" cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/>`,
  "espera-merge": `<g class="g"><path d="M5 2.8h6M5 13.2h6M5.6 2.8L10.4 13.2M10.4 2.8L5.6 13.2"/></g>`,
  "aprende-chequeo": `<circle cx="8" cy="8" r="5.5"/><path class="g" d="M8 8V4.6"/>`,
  pausa: `<g class="g"><path d="M6 4.5v7M10 4.5v7"/></g>`,
  // ↺, como el carácter que mostraba antes: apunta hacia atrás y gira para ese lado (fr-vuelta).
  vuelve: `<g class="g"><path d="M3.5 8a4.5 4.5 0 1 0 1.32-3.18"/><path d="M4.4 2.4v2.8h2.8"/></g>`,
  falla: `<path d="M5 5l6 6M11 5l-6 6"/>`,
  cortada: `<path d="M5 8h6" opacity=".55"/>`,
  "tarea-pendiente": `<circle cx="8" cy="8" r="3.2" opacity=".55"/>`,
  "tarea-corriendo": `<circle cx="8" cy="8" r="4" opacity=".2"/><path class="g" d="M8 4a4 4 0 0 1 4 4"/>`,
  "tarea-lista": `<path d="M4.6 8.3l2.3 2.3 4.5-4.8"/>`,
  "tarea-falla": `<path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>`,
};

/**
 * El SVG del indicador, del color del tono. `ahora`, en ms, fija la fase del ciclo: con
 * `Date.now()` cada redibujo sigue donde iba la animación. `etiqueta`, para lectores de pantalla.
 */
export function indicador(clave: Indicador, tone: Tone, ahora: number, etiqueta?: string): string {
  const periodo = PERIODO[clave];
  const fase = periodo === undefined ? "" : ` style="--fr-t:-${String(ahora % periodo)}ms"`;
  const a11y =
    etiqueta === undefined
      ? ` aria-hidden="true"`
      : ` role="img" aria-label="${escapeAttr(etiqueta)}"`;
  return `<svg class="fr-i fr-${clave} t-${tone}"${fase}${a11y} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${DIBUJO[clave]}</svg>`;
}

const escapeAttr = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/**
 * Las animaciones, una por indicador. `--fr-t` es la fase del ciclo que pone `indicador`; los
 * puntos y barras desfasados suman su propio corrimiento, siempre negativo: uno positivo dejaría el
 * punto quieto y entero hasta arrancar, un parpadeo en cada redibujo. Con movimiento reducido, todo
 * quieto.
 */
export const INDICADORES_CSS = `
.fr-i { flex: none; display: block; overflow: visible; }
.fr-i .g { transform-box: fill-box; transform-origin: center; }
.fr-preparar .g, .fr-tarea-corriendo .g { transform-box: view-box; transform-origin: 8px 8px; animation: fr-gira 900ms linear infinite; animation-delay: var(--fr-t, 0ms); }
.fr-planificar .g { animation: fr-late 1200ms ease-in-out infinite; animation-delay: var(--fr-t, 0ms); }
.fr-planificar .d1 { animation-delay: calc(var(--fr-t, 0ms) - 1050ms); }
.fr-planificar .d2 { animation-delay: calc(var(--fr-t, 0ms) - 900ms); }
.fr-implementar .g { transform-origin: bottom; animation: fr-barra 1000ms ease-in-out infinite; animation-delay: var(--fr-t, 0ms); }
.fr-implementar .d1 { animation-delay: calc(var(--fr-t, 0ms) - 333ms); }
.fr-implementar .d2 { animation-delay: calc(var(--fr-t, 0ms) - 666ms); }
.fr-verificar .g { stroke-dasharray: 10; animation: fr-dibuja 1600ms ease-in-out infinite; animation-delay: var(--fr-t, 0ms); }
.fr-revisar .g { animation: fr-busca 1800ms ease-in-out infinite; animation-delay: var(--fr-t, 0ms); }
.fr-probar .g { animation: fr-onda 1400ms ease-out infinite; animation-delay: var(--fr-t, 0ms); }
.fr-entregar .g { animation: fr-sube 1300ms ease-in-out infinite; animation-delay: var(--fr-t, 0ms); }
.fr-aprender .g { transform-box: view-box; transform-origin: 8px 8px; animation: fr-gira 2400ms linear infinite; animation-delay: var(--fr-t, 0ms); }
.fr-te-espera .g { animation: fr-respira 2200ms ease-in-out infinite; animation-delay: var(--fr-t, 0ms); }
.fr-espera-merge .g { animation: fr-arena 3000ms ease-in-out infinite; animation-delay: var(--fr-t, 0ms); }
.fr-aprende-chequeo .g { transform-box: view-box; transform-origin: 8px 8px; animation: fr-gira 4000ms linear infinite; animation-delay: var(--fr-t, 0ms); }
.fr-pausa .g { animation: fr-titila 1800ms ease-in-out infinite; animation-delay: var(--fr-t, 0ms); }
.fr-vuelve .g { transform-box: view-box; transform-origin: 8px 8px; animation: fr-vuelta 2400ms cubic-bezier(.6,0,.3,1) infinite; animation-delay: var(--fr-t, 0ms); }
@keyframes fr-gira { to { transform: rotate(360deg); } }
@keyframes fr-late { 0%, 80%, 100% { opacity: .25; transform: scale(.75); } 40% { opacity: 1; transform: scale(1); } }
@keyframes fr-barra { 0%, 100% { transform: scaleY(.35); } 50% { transform: scaleY(1); } }
@keyframes fr-dibuja { 0% { stroke-dashoffset: 10; opacity: 1; } 45%, 75% { stroke-dashoffset: 0; opacity: 1; } 100% { stroke-dashoffset: 0; opacity: 0; } }
@keyframes fr-busca { 0%, 100% { transform: translate(-1.2px, 0); } 50% { transform: translate(1.2px, 1px); } }
@keyframes fr-onda { 0% { transform: scale(1); opacity: .9; } 100% { transform: scale(3.2); opacity: 0; } }
@keyframes fr-sube { 0% { transform: translateY(2px); opacity: 0; } 35%, 65% { transform: translateY(0); opacity: 1; } 100% { transform: translateY(-2px); opacity: 0; } }
@keyframes fr-respira { 0%, 100% { transform: scale(.8); opacity: .45; } 50% { transform: scale(1); opacity: 1; } }
@keyframes fr-arena { 0%, 65% { transform: rotate(0); } 85%, 100% { transform: rotate(180deg); } }
@keyframes fr-titila { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
@keyframes fr-vuelta { 0% { transform: rotate(0); } 45%, 100% { transform: rotate(-360deg); } }
@media (prefers-reduced-motion: reduce) { .fr-i, .fr-i * { animation: none !important; } }
`;
