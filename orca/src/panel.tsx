// El panel de flowrunner en la barra derecha de Orca. Los runs más recientes arriba; cada uno se
// contrae o se expande tocándolo, y los terminados arrancan contraídos. Dentro, las fases listas en
// una línea, la etapa actual con su detalle, lo que falta, y las decisiones que el run espera.
// Sin paso de build: Orca quita los tipos y compila el JSX al cargarlo.
import {
  atom,
  Badge,
  Button,
  Code,
  EmptyState,
  IconButton,
  Input,
  Link,
  List,
  ListItem,
  plugin,
  read,
  Row,
  Separator,
  set,
  Spinner,
  Stack,
  Text,
  update,
  type PanelContext,
} from "orca";
import type { Outcome, Snapshot, Steps } from "./protocol";
import {
  decisionsFor,
  isFinished,
  rerunPhase,
  RUN_STATE,
  runSummary,
  runView,
  sortRuns,
  type CurrentPhase,
  type Decision,
  type Run,
  type SessionLine,
} from "./runs";

const REFRESH_MS = 3_000;
/** Lo último de un texto largo: los pasos o el plan. */
const TAIL_CHARS = 4_000;
const PLAN_CHARS = 20_000;

const snapshot = atom<Snapshot | null>(null);
/** Runs que la persona abrió o cerró a mano; el resto sigue el default: terminados, cerrados. */
const toggled = atom("abiertos", {} as Record<string, boolean>, { persist: "plugin" });
const doneOpen = atom({} as Record<string, boolean>);
const steps = atom<(Steps & { run: string }) | null>(null);
const plan = atom<{ run: string; texto: string } | null>(null);
/** La decisión que espera confirmación, o el pedido de cambios que se está escribiendo. */
const pending = atom<{ run: string; decision: Decision } | null>(null);
const draft = atom("");
const outcome = atom<(Outcome & { run: string }) | null>(null);
const busy = atom<string | null>(null);

const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);

async function refresh(): Promise<void> {
  set(snapshot, await plugin.request("flowrunner.runs"));
}

async function withBusy<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
  set(busy, label);
  try {
    return await task();
  } catch (error) {
    set(outcome, { run: "", ok: false, mensaje: String(error) });
    return undefined;
  } finally {
    set(busy, null);
  }
}

async function showSteps(run: string, sesion: string): Promise<void> {
  const answer = await withBusy(`Leyendo los pasos de ${sesion}`, () =>
    plugin.request("flowrunner.pasos", { run, sesion }),
  );
  if (answer !== undefined) set(steps, { run, ...answer });
}

async function showPlan(run: string): Promise<void> {
  const answer = await withBusy("Leyendo el plan", () =>
    plugin.request("flowrunner.plan", { run }),
  );
  if (answer !== undefined) set(plan, { run, texto: answer.texto });
}

async function decide(run: string, decision: Decision): Promise<void> {
  set(pending, null);
  const answer = await withBusy("Enviando la decisión", () =>
    plugin.request("flowrunner.decidir", { run, decision }),
  );
  if (answer === undefined) return;
  set(outcome, { run, ...answer });
  if (answer.ok) {
    set(draft, "");
    set(plan, null);
  }
  await refresh();
}

/** Lee los runs al abrir y cada 3 segundos mientras el panel se ve. */
export function setup(ctx: PanelContext): void {
  void refresh();
  const timer = setInterval(() => {
    if (read(ctx.visible)) void refresh();
  }, REFRESH_MS);
  ctx.signal.addEventListener("abort", () => clearInterval(timer));
}

const isOpen = (run: Run) => read(toggled)[run.id] ?? !isFinished(run);

function SessionRow({ run, s, indent }: { run: string; s: SessionLine; indent: string }) {
  return (
    <Stack gap="none">
      <Row justify="between" align="center">
        <Text size="xs" muted={!s.corriendo} truncate>
          {`${indent}${s.corriendo ? "▶" : "·"} ${s.texto}`}
        </Text>
        <IconButton
          icon="file-text"
          label={`Pasos de ${s.nombre}`}
          variant="ghost"
          size="sm"
          onPress={() => showSteps(run, s.nombre)}
        />
      </Row>
      {s.ahora === undefined ? null : (
        <Text size="xs" tone="accent" truncate>
          {`${indent}   ${s.ahora}`}
        </Text>
      )}
    </Stack>
  );
}

function Current({ run, p }: { run: Run; p: CurrentPhase }) {
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Text weight="semibold" tone={p.tone} truncate>{`${p.mark} ${p.fase}`}</Text>
        <Badge tone={p.tone}>{p.estado}</Badge>
      </Row>
      {p.meta === "" ? null : (
        <Text size="xs" muted>
          {p.meta}
        </Text>
      )}
      {p.detalle === undefined ? null : <Text size="xs">{p.detalle}</Text>}
      {p.sesiones.map((s) => (
        <SessionRow key={s.nombre} run={run.id} s={s} indent="" />
      ))}
      {p.unidades.map((u) => (
        <Stack key={u.id} gap="none">
          <Row justify="between" align="center">
            <Text size="xs" truncate>
              {u.texto}
            </Text>
            <Text size="xs" muted>
              {u.meta}
            </Text>
          </Row>
          {u.sesiones.map((s) => (
            <SessionRow key={s.nombre} run={run.id} s={s} indent={"  "} />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

function Decisions({ run }: { run: Run }) {
  const offered = decisionsFor(run);
  const waiting = read(pending);
  const mine = waiting?.run === run.id ? waiting.decision : undefined;
  if (offered.length === 0) return null;
  if (mine !== undefined && mine.accion === "cambios") {
    const send = () => decide(run.id, { accion: "cambios", motivo: read(draft) });
    return (
      <Stack gap="xs">
        <Input
          label="Qué cambiar del plan"
          placeholder="En tus palabras: qué corregir y qué mantener"
          value={read(draft)}
          onChange={(v) => set(draft, v)}
          onSubmit={send}
        />
        <Row gap="xs">
          <Button size="sm" disabled={read(draft).trim() === ""} onPress={send}>
            Enviar cambios
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(pending, null)}>
            Cancelar
          </Button>
        </Row>
      </Stack>
    );
  }
  if (mine !== undefined) {
    const question =
      mine.accion === "aprobar"
        ? `¿Aprobar el plan de ${run.clave}? Arranca la implementación.`
        : mine.accion === "reanudar"
          ? `¿Reanudar ${run.clave}?`
          : `¿Rehacer ${run.clave} desde ${mine.accion === "rehacer" ? mine.desde : ""}?`;
    return (
      <Stack gap="xs">
        <Text size="sm">{question}</Text>
        <Row gap="xs">
          <Button size="sm" tone="success" onPress={() => decide(run.id, mine)}>
            Sí, confirmar
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(pending, null)}>
            Cancelar
          </Button>
        </Row>
      </Stack>
    );
  }
  const ask = (decision: Decision) => set(pending, { run: run.id, decision });
  const desde = rerunPhase(run);
  return (
    <Row gap="xs" wrap>
      {run.status === "esperando_aprobacion" ? (
        <Button size="sm" variant="outline" onPress={() => showPlan(run.id)}>
          Ver plan
        </Button>
      ) : null}
      {offered.includes("aprobar") ? (
        <Button size="sm" onPress={() => ask({ accion: "aprobar" })}>
          Aprobar
        </Button>
      ) : null}
      {offered.includes("cambios") ? (
        <Button size="sm" variant="outline" onPress={() => ask({ accion: "cambios", motivo: "" })}>
          Pedir cambios
        </Button>
      ) : null}
      {offered.includes("reanudar") ? (
        <Button size="sm" onPress={() => ask({ accion: "reanudar" })}>
          Reanudar
        </Button>
      ) : null}
      {offered.includes("rehacer") && desde !== undefined ? (
        <Button size="sm" variant="outline" onPress={() => ask({ accion: "rehacer", desde })}>
          {`Rehacer desde ${desde}`}
        </Button>
      ) : null}
    </Row>
  );
}

function RunBody({ run }: { run: Run }) {
  const view = runView(run);
  const showDone = read(doneOpen)[run.id] === true;
  const said = read(outcome);
  const shownSteps = read(steps);
  const shownPlan = read(plan);
  return (
    <Stack gap="sm">
      {run.motivo === undefined ? null : (
        <Text size="sm" tone="danger">
          {run.motivo}
        </Text>
      )}
      <Decisions run={run} />
      {said?.run === run.id ? (
        <Text size="sm" tone={said.ok ? "success" : "danger"}>
          {said.mensaje}
        </Text>
      ) : null}
      {run.siguiente?.startsWith("https://") === true ? (
        <Row>
          <Link href={run.siguiente}>Abrir la PR</Link>
        </Row>
      ) : null}
      {shownPlan?.run === run.id ? (
        <Stack gap="xs">
          <Code block>{tail(shownPlan.texto, PLAN_CHARS)}</Code>
          <Row>
            <Button size="sm" variant="ghost" onPress={() => set(plan, null)}>
              Cerrar el plan
            </Button>
          </Row>
        </Stack>
      ) : null}
      {view.listas.length === 0 ? null : (
        <Stack gap="none">
          <Row>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => update(doneOpen, (m) => ({ ...m, [run.id]: !showDone }))}
            >
              {`${showDone ? "▾" : "▸"} ✓ ${String(view.listas.length)} ${view.listas.length === 1 ? "lista" : "listas"}`}
            </Button>
          </Row>
          {showDone
            ? view.listas.map((p) => (
                <Text key={p.fase} size="xs" muted truncate>
                  {`✓ ${p.fase}${p.meta === "" ? "" : ` · ${p.meta}`}`}
                </Text>
              ))
            : null}
        </Stack>
      )}
      {view.actuales.map((p) => (
        <Current key={p.fase} run={run} p={p} />
      ))}
      {shownSteps?.run === run.id ? (
        <Stack gap="xs">
          <Text size="xs" weight="semibold">{`Pasos de ${shownSteps.sesion}`}</Text>
          <Code block>{tail(shownSteps.texto, TAIL_CHARS) || "(sin pasos todavía)"}</Code>
          <Row>
            <Button size="sm" variant="ghost" onPress={() => set(steps, null)}>
              Cerrar los pasos
            </Button>
          </Row>
        </Stack>
      ) : null}
      {view.faltan.length === 0 ? null : (
        <Text size="xs" muted>
          {`Faltan: ${view.faltan.join(", ")}`}
        </Text>
      )}
    </Stack>
  );
}

function RunBlock({ run }: { run: Run }) {
  const open = isOpen(run);
  return (
    <Stack gap="xs">
      <List label={`Run ${run.clave}`}>
        <ListItem
          title={`${open ? "▾" : "▸"} ${run.clave} · ${run.titulo}`}
          description={runSummary(run)}
          icon={RUN_STATE[run.status].icon}
          onPress={() => update(toggled, (m) => ({ ...m, [run.id]: !open }))}
        />
      </List>
      {open ? <RunBody run={run} /> : null}
    </Stack>
  );
}

export default function Panel() {
  const snap = read(snapshot);
  const working = read(busy);
  if (snap === null) return <Spinner label="Leyendo los runs de flowrunner" />;
  const runs = sortRuns(snap.runs);
  return (
    <Stack gap="sm">
      {snap.error === undefined ? null : (
        <Text size="sm" tone="danger">
          No se pudo leer flowrunner: {snap.error}
        </Text>
      )}
      {working === null ? null : <Spinner label={working} />}
      {runs.length === 0 && snap.error === undefined ? (
        <EmptyState
          title="No hay runs activos"
          description="Cuando lances una feature desde Claude Code, su progreso aparece acá."
        />
      ) : (
        runs.map((run, i) => (
          <Stack key={run.id} gap="sm">
            {i === 0 ? null : <Separator />}
            <RunBlock run={run} />
          </Stack>
        ))
      )}
    </Stack>
  );
}
