// Los indicadores de estado: uno distinto por estado, y por etapa cuando trabaja.
import { assert, test } from "orca/testing";
import {
  indicador,
  indicadorDeEtapa,
  indicadorDeTarea,
  INDICADORES_CSS,
  PERIODO,
  type Indicador,
} from "./indicadores";
import { STATIONS } from "./runs";

// Si regresiona, dos estados distintos se ven igual y el panel deja de decir qué pasa.
test("cada estado de etapa, y cada etapa que trabaja, tiene su indicador", () => {
  const working = STATIONS.filter((f) => f !== "aprobar").map((f) =>
    indicadorDeEtapa(f, "corriendo"),
  );
  assert.deepEqual(working, [
    "preparar",
    "planificar",
    "implementar",
    "verificar",
    "revisar",
    "probar",
    "entregar",
    "aprender",
  ]);
  assert.equal(indicadorDeEtapa("aprobar", "espera"), "te-espera");
  assert.equal(indicadorDeEtapa("entregar", "espera"), "espera-merge");
  assert.equal(indicadorDeEtapa("aprender", "espera", true), "aprende-chequeo");
  assert.equal(indicadorDeEtapa("verificar", "vuelve"), "vuelve");
  assert.equal(indicadorDeEtapa("verificar", "falla"), "falla");
  assert.equal(indicadorDeEtapa("planificar", "pausa"), "pausa");
  assert.equal(indicadorDeEtapa("aprobar", "cortada"), "cortada");
  assert.equal(indicadorDeEtapa("probar", "ok"), "ok");
  assert.equal(indicadorDeEtapa("probar", "pendiente"), "pendiente");
});

// Si regresiona, un estado nuevo de flowrunner rompe el panel en vez de verse como algo por hacer.
test("un estado o una etapa que el panel no conoce no rompe: pendiente, o el arco de trabajando", () => {
  assert.equal(indicadorDeEtapa("verificar", "algo-nuevo"), "pendiente");
  assert.equal(indicadorDeEtapa("una-etapa-nueva", "corriendo"), "preparar");
  assert.equal(indicadorDeTarea("algo-nuevo"), "tarea-pendiente");
});

test("las sub-tasks: pendiente, trabajando, lista o fallida", () => {
  assert.deepEqual(
    ["pendiente", "corriendo", "commiteada", "integrada", "sin_cambios", "fallida", "cortada"].map(
      indicadorDeTarea,
    ),
    [
      "tarea-pendiente",
      "tarea-corriendo",
      "tarea-lista",
      "tarea-lista",
      "tarea-lista",
      "tarea-falla",
      "cortada",
    ],
  );
});

const TODOS: Indicador[] = [
  "pendiente",
  "ok",
  "preparar",
  "planificar",
  "implementar",
  "verificar",
  "revisar",
  "probar",
  "entregar",
  "aprender",
  "te-espera",
  "espera-merge",
  "aprende-chequeo",
  "pausa",
  "vuelve",
  "falla",
  "cortada",
  "tarea-pendiente",
  "tarea-corriendo",
  "tarea-lista",
  "tarea-falla",
];

test("no hay dos indicadores con el mismo dibujo", () => {
  const dibujo = (k: Indicador) => indicador(k, "neutral", 0).replace(/^<svg[^>]*>/, "");
  const dibujos = TODOS.map(dibujo);
  assert.equal(new Set(dibujos).size, TODOS.length);
});

// Si regresiona, cada redibujo de 3 s hace saltar la animación al principio.
test("lo vivo se mueve y sigue donde iba al redibujar; lo terminado queda quieto", () => {
  for (const k of TODOS) {
    const periodo = PERIODO[k];
    const svg = indicador(k, "accent", 12_345);
    if (periodo === undefined) {
      assert.equal(svg.includes("--fr-t"), false, k);
      continue;
    }
    assert.ok(svg.includes(`--fr-t:-${String(12_345 % periodo)}ms`), k);
    assert.ok(INDICADORES_CSS.includes(`.fr-${k} .g`), `${k} sin animación`);
  }
  // Lo vivo: trabaja, te espera, en pausa, volvió. Lo terminado o por hacer, quieto.
  for (const k of [
    "ok",
    "pendiente",
    "falla",
    "cortada",
    "tarea-lista",
    "tarea-pendiente",
    "tarea-falla",
  ] as const)
    assert.equal(PERIODO[k], undefined, k);
});

test("con movimiento reducido, todo queda quieto", () => {
  assert.match(
    INDICADORES_CSS,
    /prefers-reduced-motion: reduce\) \{ \.fr-i, \.fr-i \* \{ animation: none !important; \}/,
  );
});

test("el indicador lleva el color del tono y, si se pide, una etiqueta escapada para lectores de pantalla", () => {
  const svg = indicador("te-espera", "warning", 0, `Aprobar: "te espera" <ya>`);
  assert.match(svg, /class="fr-i fr-te-espera t-warning"/);
  assert.match(svg, /role="img" aria-label="Aprobar: &quot;te espera&quot; &lt;ya>"/);
  assert.match(indicador("ok", "success", 0), /aria-hidden="true"/);
});
