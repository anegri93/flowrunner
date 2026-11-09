// El init script del navegador de probar: hace que el video se entienda sin nadie al lado. Lo pidió la
// persona después de KMS-1 (ADR 0017): en el video solo se veían destellos y cambios de página, y lo
// que quedaba más abajo de la pantalla se tocaba fuera de cuadro.
//
// Corre en cada página antes que sus scripts. Lo automático no depende del agente: un cursor que sigue
// al mouse que mueve Playwright y marca cada clic, y lo que recibe foco o un clic queda centrado con un
// scroll suave. Lo narrado lo pone el agente con `browser_evaluate`: `flowrunner.placa`, `rotulo` y
// `veredicto`.

export const GUION_DEL_VIDEO = `(() => {
  if (window.flowrunner) return;
  const CSS = \`
#fr-cursor{position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
  background:rgba(255,72,0,.85);border:3px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.35);z-index:2147483646;
  pointer-events:none;transition:left .35s ease-out,top .35s ease-out}
#fr-cursor.fr-clic{animation:fr-pulso .6s ease-out}
@keyframes fr-pulso{0%{box-shadow:0 0 0 0 rgba(255,72,0,.8)}100%{box-shadow:0 0 0 26px rgba(255,72,0,0)}}
#fr-rotulo{position:fixed;left:0;right:0;bottom:0;z-index:2147483645;background:#101418;color:#fff;
  font:600 18px/1.45 system-ui,sans-serif;padding:12px 20px;white-space:pre-line;pointer-events:none}
#fr-placa{position:fixed;inset:0;z-index:2147483647;background:#101418;color:#fff;display:flex;flex-direction:column;
  justify-content:center;padding:0 100px;font:400 24px/1.6 system-ui,sans-serif;white-space:pre-line}
#fr-placa h1{font:700 40px/1.2 system-ui,sans-serif;margin:0 0 24px}
#fr-veredicto{position:fixed;top:20px;right:20px;z-index:2147483646;padding:14px 20px;border-radius:10px;
  font:700 20px/1.35 system-ui,sans-serif;color:#fff;max-width:520px;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:none}
.fr-toque{outline:4px solid #ff8a00 !important;outline-offset:3px !important}
.fr-ok{outline:5px solid #16a34a !important;outline-offset:4px !important}
.fr-mal{outline:5px solid #dc2626 !important;outline-offset:4px !important}\`;
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const nodo = (id, tag = "div") => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement(tag);
      el.id = id;
      document.documentElement.appendChild(el);
    }
    return el;
  };
  const centrar = (el) => {
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  };
  const montar = () => {
    nodo("fr-estilo", "style").textContent = CSS;
    nodo("fr-cursor");
    // El rótulo sobrevive a una recarga: la SPA a veces navega con una carga completa.
    let guardado = "";
    try { guardado = sessionStorage.getItem("fr-rotulo") || ""; } catch {}
    if (guardado) {
      const r = nodo("fr-rotulo");
      r.textContent = guardado;
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", montar);
  else montar();

  addEventListener("mousemove", (e) => {
    const c = document.getElementById("fr-cursor");
    if (c) Object.assign(c.style, { left: e.clientX + "px", top: e.clientY + "px" });
  }, true);
  addEventListener("pointerdown", (e) => {
    const c = document.getElementById("fr-cursor");
    if (c) { c.classList.remove("fr-clic"); void c.offsetWidth; c.classList.add("fr-clic"); }
    const t = e.target instanceof Element ? e.target.closest("button,a,input,select,textarea,label,[role]") || e.target : null;
    if (t) { t.classList.add("fr-toque"); setTimeout(() => t.classList.remove("fr-toque"), 900); }
  }, true);
  // Lo que se va a tipear o elegir queda en el centro, no asomando debajo del rótulo.
  addEventListener("focusin", (e) => centrar(e.target), true);

  window.flowrunner = {
    /** Pantalla completa antes de cada criterio: qué se prueba y qué debería pasar. */
    async placa(titulo, texto, ms = 5000) {
      const p = nodo("fr-placa");
      p.textContent = "";
      const h = document.createElement("h1");
      h.textContent = titulo;
      const d = document.createElement("div");
      d.textContent = texto || "";
      p.append(h, d);
      await esperar(ms);
      p.remove();
    },
    /** La barra de abajo: en qué paso está la prueba. Vacío la saca. */
    rotulo(texto) {
      try { sessionStorage.setItem("fr-rotulo", texto || ""); } catch {}
      const r = nodo("fr-rotulo");
      r.textContent = texto || "";
      r.style.display = texto ? "block" : "none";
    },
    /** Al final de cada criterio: centra lo que lo prueba, lo marca en verde o rojo y lo deja quieto. */
    async veredicto(ok, texto, selector, ms = 4000) {
      const el = selector ? document.querySelector(selector) : null;
      if (el) { centrar(el); await esperar(900); el.classList.add(ok ? "fr-ok" : "fr-mal"); }
      const v = nodo("fr-veredicto");
      v.style.background = ok ? "#16a34a" : "#dc2626";
      v.textContent = (ok ? "✔ PASÓ · " : "✘ FALLÓ · ") + texto;
      await esperar(ms);
      v.remove();
      if (el) el.classList.remove("fr-ok", "fr-mal");
      return el ? "marcado" : "sin elemento: " + selector;
    },
  };
})();
`;
