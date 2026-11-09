// El panel de flowrunner en la barra derecha de Orca. Cada run se lee como el seguimiento de un
// pedido: una frase con su estado, una barra de avance, cinco pasos (Plan, Tu OK, Código, Control,
// PR) y el detalle de lo que pasa ahora, con las decisiones que espera. Los más recientes arriba;
// los terminados muestran solo el resumen hasta que se abren.
// Sin paso de build: Orca quita los tipos y compila el JSX al cargarlo.
import {
  atom,
  Button,
  Card,
  Code,
  EmptyState,
  IconButton,
  Input,
  Link,
  plugin,
  Progress,
  read,
  Row,
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
  headlineOf,
  isFinished,
  needsYou,
  nowOf,
  progressOf,
  rerunPhase,
  sortRuns,
  STEP_MARK,
  stepsOf,
  tail,
  type Decision,
  type PlanView,
  type Run,
} from "./runs";

const REFRESH_MS = 3_000;

const snapshot = atom<Snapshot | null>(null);
/** Runs que la persona abrió o cerró a mano; el resto sigue el default. */
const toggled = atom("abiertos", {} as Record<string, boolean>, { persist: "plugin" });
const steps = atom<(Steps & { run: string }) | null>(null);
const plan = atom<(PlanView & { run: string }) | null>(null);
/** La decisión que espera confirmación, o el pedido de cambios que se está escribiendo. */
const pending = atom<{ run: string; decision: Decision } | null>(null);
const draft = atom("");
const outcome = atom<(Outcome & { run: string }) | null>(null);
const busy = atom<{ run: string; texto: string } | null>(null);

async function refresh(): Promise<void> {
  set(snapshot, await plugin.request("flowrunner.runs"));
}

/** Corre un pedido al worker mostrando qué espera; un error queda escrito en el run. */
async function withBusy<T>(
  run: string,
  texto: string,
  task: () => Promise<T>,
): Promise<T | undefined> {
  set(busy, { run, texto });
  try {
    return await task();
  } catch (error) {
    set(outcome, {
      run,
      ok: false,
      mensaje: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  } finally {
    set(busy, null);
  }
}

async function showSteps(run: string, sesion: string): Promise<void> {
  const answer = await withBusy(run, `Leyendo los pasos de ${sesion}`, () =>
    plugin.request("flowrunner.pasos", { run, sesion }),
  );
  if (answer !== undefined) set(steps, { run, ...answer });
}

async function showPlan(run: string): Promise<void> {
  const answer = await withBusy(run, "Leyendo el plan", () =>
    plugin.request("flowrunner.plan", { run }),
  );
  if (answer !== undefined) set(plan, { run, ...answer });
}

async function decide(run: string, decision: Decision): Promise<void> {
  set(pending, null);
  const answer = await withBusy(run, "Enviando tu decisión", () =>
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

const isOpen = (run: Run) => read(toggled)[run.id] ?? (needsYou(run) || !isFinished(run));

/** Los cinco pasos, como en el seguimiento de un pedido. */
function Tracker({ run }: { run: Run }) {
  return (
    <Row justify="between">
      {stepsOf(run).map((step) => {
        const { mark, tone } = STEP_MARK[step.estado];
        const now = step.estado === "ahora" || step.estado === "espera" || step.estado === "falla";
        return (
          <Stack key={step.label} gap="none" align="center">
            <Text tone={tone} muted={step.estado === "pendiente"} weight="semibold">
              {mark}
            </Text>
            <Text
              size="xs"
              tone={now ? tone : "neutral"}
              muted={!now}
              weight={now ? "semibold" : "regular"}
            >
              {step.label}
            </Text>
          </Stack>
        );
      })}
    </Row>
  );
}

function Decisions({ run }: { run: Run }) {
  const offered = decisionsFor(run);
  const waiting = read(pending);
  const mine = waiting?.run === run.id ? waiting.decision : undefined;
  if (offered.length === 0) return null;
  if (mine?.accion === "cambios") {
    const send = () => decide(run.id, { accion: "cambios", motivo: read(draft) });
    return (
      <Stack gap="xs">
        <Input
          label="Qué cambiar del plan"
          placeholder="Qué corregir y qué mantener"
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
        ? "¿Aprobar el plan? Arranca la implementación."
        : mine.accion === "reanudar"
          ? `¿Reanudar ${run.clave}?`
          : `¿Rehacer ${run.clave} desde ${mine.accion === "rehacer" ? mine.desde : ""}?`;
    return (
      <Stack gap="xs">
        <Text size="sm" weight="semibold">
          {question}
        </Text>
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
      {offered.includes("aprobar") ? (
        <Button size="sm" tone="success" icon="check" onPress={() => ask({ accion: "aprobar" })}>
          Aprobar
        </Button>
      ) : null}
      {offered.includes("cambios") ? (
        <Button
          size="sm"
          variant="outline"
          icon="edit"
          onPress={() => ask({ accion: "cambios", motivo: "" })}
        >
          Pedir cambios
        </Button>
      ) : null}
      {run.status === "esperando_aprobacion" ? (
        <Button size="sm" variant="ghost" icon="file-text" onPress={() => showPlan(run.id)}>
          Ver plan
        </Button>
      ) : null}
      {offered.includes("reanudar") ? (
        <Button size="sm" icon="play" onPress={() => ask({ accion: "reanudar" })}>
          Reanudar
        </Button>
      ) : null}
      {offered.includes("rehacer") && desde !== undefined ? (
        <Button
          size="sm"
          variant="outline"
          icon="refresh"
          onPress={() => ask({ accion: "rehacer", desde })}
        >
          {`Rehacer desde ${desde}`}
        </Button>
      ) : null}
    </Row>
  );
}

function PlanPanel({ p }: { p: PlanView }) {
  return (
    <Stack gap="xs">
      <Text size="sm" weight="semibold">
        {`Plan: ${String(p.subtareas.length)} sub-tasks · ${String(p.criterios)} criterios`}
      </Text>
      {p.subtareas.map((t) => (
        <Text key={t.id} size="xs" truncate>
          {`${t.id}  ${t.titulo}`}
        </Text>
      ))}
      {p.cambios.length === 0 ? null : (
        <Stack gap="none">
          <Text size="xs" weight="semibold" tone="warning">
            Contra el plan anterior
          </Text>
          {p.cambios.map((c) => (
            <Text key={c} size="xs" tone="warning">
              {c}
            </Text>
          ))}
        </Stack>
      )}
      <Code block>{p.texto}</Code>
      {p.recortado ? (
        <Text size="xs" muted>
          Es el comienzo del plan; completo con flowrunner plan.
        </Text>
      ) : null}
      <Row>
        <Button size="sm" variant="ghost" onPress={() => set(plan, null)}>
          Cerrar el plan
        </Button>
      </Row>
    </Stack>
  );
}

function Detail({ run }: { run: Run }) {
  const now = nowOf(run);
  const said = read(outcome);
  const working = read(busy);
  const shownSteps = read(steps);
  const shownPlan = read(plan);
  return (
    <Stack gap="sm">
      {run.motivo === undefined ? null : (
        <Text size="sm" tone="danger">
          {tail(run.motivo, 1_500)}
        </Text>
      )}
      {now.detalle === undefined || run.motivo !== undefined ? null : (
        <Text size="xs" tone="warning">
          {tail(now.detalle, 1_500)}
        </Text>
      )}
      <Decisions run={run} />
      {working?.run === run.id ? <Spinner label={working.texto} /> : null}
      {said?.run === run.id ? (
        <Text size="sm" tone={said.ok ? "success" : "danger"}>
          {said.mensaje}
        </Text>
      ) : null}
      {shownPlan?.run === run.id ? <PlanPanel p={shownPlan} /> : null}
      {now.tareas.length === 0 ? null : (
        <Stack gap="none">
          {now.tareas.map((t) => (
            <Row key={t.key} justify="between" align="center">
              <Text size="sm" tone={t.tone} muted={t.tone === "neutral"} truncate>
                {`${t.mark} ${t.texto}`}
              </Text>
              <Text size="xs" muted>
                {t.nota ?? ""}
              </Text>
            </Row>
          ))}
        </Stack>
      )}
      {now.actividad.map((a) => (
        <Stack key={a.sesion} gap="none">
          <Row justify="between" align="center">
            <Text size="xs" muted truncate>
              {a.texto}
            </Text>
            <IconButton
              icon="file-text"
              label={`Pasos de ${a.sesion}`}
              variant="ghost"
              size="sm"
              onPress={() => showSteps(run.id, a.sesion)}
            />
          </Row>
          {a.ahora === undefined ? null : (
            <Text size="xs" tone="accent" truncate>
              {a.ahora}
            </Text>
          )}
        </Stack>
      ))}
      {shownSteps?.run === run.id ? (
        <Stack gap="xs">
          <Code block>{tail(shownSteps.texto) || "(sin pasos todavía)"}</Code>
          <Row>
            <Button size="sm" variant="ghost" onPress={() => set(steps, null)}>
              Cerrar los pasos
            </Button>
          </Row>
        </Stack>
      ) : null}
      {run.siguiente?.startsWith("https://") === true ? (
        <Row>
          <Link href={run.siguiente}>Abrir la PR</Link>
        </Row>
      ) : null}
      <Text size="xs" muted>
        {now.meta}
      </Text>
    </Stack>
  );
}

function RunCard({ run }: { run: Run }) {
  const open = isOpen(run);
  const headline = headlineOf(run);
  return (
    <Card title={`${run.clave} · ${run.titulo}`}>
      <Stack gap="sm">
        <Row justify="between" align="center">
          <Text weight="semibold" tone={headline.tone}>
            {`${headline.emoji} ${headline.texto}`}
          </Text>
          <IconButton
            icon={open ? "collapse" : "expand"}
            label={open ? `Ocultar el detalle de ${run.clave}` : `Ver el detalle de ${run.clave}`}
            variant="ghost"
            size="sm"
            onPress={() => update(toggled, (m) => ({ ...m, [run.id]: !open }))}
          />
        </Row>
        <Progress label={`Avance de ${run.clave}`} labelHidden value={progressOf(run)} />
        <Tracker run={run} />
        {open ? <Detail run={run} /> : null}
      </Stack>
    </Card>
  );
}

export default function Panel() {
  const snap = read(snapshot);
  if (snap === null) return <Spinner label="Leyendo los runs de flowrunner" />;
  const runs = sortRuns(snap.runs);
  return (
    <Stack gap="md">
      {snap.error === undefined ? null : (
        <Text size="sm" tone="danger">
          No se pudo leer flowrunner: {snap.error}
        </Text>
      )}
      {runs.length === 0 && snap.error === undefined ? (
        <EmptyState
          title="No hay runs activos"
          description="Cuando lances una feature desde Claude Code, su progreso aparece acá."
        />
      ) : (
        runs.map((run) => <RunCard key={run.id} run={run} />)
      )}
    </Stack>
  );
}
