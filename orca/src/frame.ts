// La pestaña de los runs en un frame de Orca (`sandboxed-ui`): pega `Panel` al DOM y a Orca. Es lo
// único con DOM; lo que se ve y lo que pasa al tocar viven en vista.ts y estado.ts, que tienen tests.
//
// Lee al abrir y cada 3 segundos mientras la pestaña se ve, y enseguida al cambiar de workspace.
import { Panel, type Api } from "./estado";
import { CAMPO, PANEL_CSS, type Accion } from "./vista";

const REFRESH_MS = 3_000;

const root = document.getElementById("app");
if (root === null) throw new Error("panel/index.html no tiene #app");

const style = document.createElement("style");
style.textContent = PANEL_CSS;
document.head.append(style);

const api: Api = {
  runs: () => orca.plugin.request("flowrunner.runs"),
  abrir: (run, que) => orca.plugin.request("flowrunner.abrir", { run, que }),
  decidir: (run, decision) => orca.plugin.request("flowrunner.decidir", { run, decision }),
  leer: (key) => orca.storage.get(key),
  guardar: (key, value) => orca.storage.set(key, value),
  externo: async (url) => {
    await orca.shell?.openExternal(url);
  },
  ahora: () => Date.now(),
};

/**
 * Redibuja todo. Si el foco estaba en el campo de texto, lo devuelve con su cursor: el campo se
 * redibuja también mientras se escribe, para habilitar Enviar.
 */
function draw(): void {
  if (root === null) return;
  const active = document.activeElement;
  const caret =
    active instanceof HTMLInputElement && active.id === CAMPO
      ? { start: active.selectionStart, end: active.selectionEnd }
      : undefined;
  root.innerHTML = panel.html();
  if (caret === undefined) return;
  const input = document.getElementById(CAMPO);
  if (!(input instanceof HTMLInputElement)) return;
  input.focus();
  input.setSelectionRange(caret.start, caret.end);
}

const panel = new Panel(api, draw);

/** La acción de un control: vista.ts la escribió con JSON.stringify de un `Accion`, no viene de afuera. */
const accionDe = (json: string | undefined): Accion | undefined =>
  json === undefined ? undefined : (JSON.parse(json) as Accion);

root.addEventListener("click", (event) => {
  const target =
    event.target instanceof Element ? event.target.closest("button[data-accion]") : null;
  if (!(target instanceof HTMLButtonElement) || target.disabled) return;
  const accion = accionDe(target.dataset.accion);
  if (accion !== undefined) void panel.tocar(accion);
});

root.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.id === CAMPO)
    panel.escribir(event.target.value);
});

root.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
  if (event.target.id !== CAMPO) return;
  event.preventDefault();
  const accion = accionDe(event.target.dataset.enviar);
  if (accion !== undefined) void panel.tocar(accion);
});

draw();
await panel.cargar();
orca.on("workspace.changed", ({ context }) => void panel.workspace(context));
void panel.refresh();
setInterval(() => {
  if (document.visibilityState === "visible") void panel.refresh();
}, REFRESH_MS);
