// La pestaña de los runs en la barra derecha de Orca. Cada run es una tarjeta: la etapa en que
// está con su estado, una barra de avance y las ocho etapas del flujo, como en el diagrama, y abajo
// el detalle y las decisiones que espera. Los más recientes arriba; los terminados muestran solo el
// resumen hasta que se abren. El refresco no borra nada: si una lectura falla, queda la anterior.
// Sin paso de build: Orca quita los tipos y compila el JSX al cargarlo.
import {
  atom,
  Badge,
  Button,
  Card,
  Code,
  EmptyState,
  IconButton,
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
import { Decisions } from "./decisiones";
import type { Snapshot, Steps } from "./protocol";
import {
  headlineOf,
  isFinished,
  needsYou,
  nowOf,
  phaseLabel,
  progressOf,
  sortRuns,
  stationsOf,
  tail,
  type Run,
} from "./runs";

const REFRESH_MS = 3_000;

const snapshot = atom<Snapshot | null>(null);
/** Runs que la persona abrió o cerró a mano; el resto sigue el default. */
const toggled = atom("abiertos", {} as Record<string, boolean>, { persist: "plugin" });
const steps = atom<(Steps & { run: string }) | null>(null);
const notice = atom<{ run: string; texto: string } | null>(null);

let reading = false;

/**
 * Lee los runs sin borrar lo que se ve: una lectura que falla deja los runs anteriores con el
 * error arriba, y una que no cambió nada no vuelve a dibujar. Nunca dos lecturas a la vez.
 */
export async function refresh(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    const next = await plugin.request("flowrunner.runs");
    const prev = read(snapshot);
    const shown = next.error !== undefined && prev !== null ? { ...prev, error: next.error } : next;
    const same =
      prev !== null && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...shown, at: 0 });
    if (!same) set(snapshot, shown);
  } catch (error) {
    const prev = read(snapshot);
    set(snapshot, {
      runs: prev?.runs ?? [],
      error: error instanceof Error ? error.message : String(error),
      at: Date.now(),
    });
  } finally {
    reading = false;
  }
}

async function showSteps(run: string, sesion: string): Promise<void> {
  try {
    set(steps, { run, ...(await plugin.request("flowrunner.pasos", { run, sesion })) });
  } catch (error) {
    set(notice, { run, texto: `No se pudieron leer los pasos: ${String(error)}` });
  }
}

async function openPlan(run: string): Promise<void> {
  try {
    const answer = await plugin.request("flowrunner.verPlan", { run });
    if (!answer.ok) set(notice, { run, texto: answer.mensaje });
  } catch (error) {
    set(notice, { run, texto: `No se pudo abrir el plan: ${String(error)}` });
  }
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

/** Las ocho etapas del flujo, con su nombre y su estado, en filas que se acomodan al ancho. */
function Stations({ run }: { run: Run }) {
  return (
    <Row gap="xs" wrap>
      {stationsOf(run).map((station) => {
        const label = phaseLabel(station.fase, station.estado);
        return (
          <Badge key={station.fase} tone={label.tone}>
            {`${label.mark} ${station.nombre}`}
          </Badge>
        );
      })}
    </Row>
  );
}

function Detail({ run }: { run: Run }) {
  const now = nowOf(run);
  const shownSteps = read(steps);
  const said = read(notice);
  return (
    <Stack gap="sm">
      {run.motivo === undefined ? null : (
        <Text size="sm" tone="danger">
          {tail(run.motivo, 1_500)}
        </Text>
      )}
      {now.detalle === undefined || run.motivo !== undefined ? null : (
        <Text size="xs" tone="warning">
          {now.detalle.length > 280 ? `${now.detalle.slice(0, 280)}…` : now.detalle}
        </Text>
      )}
      <Decisions run={run} after={refresh} onPlan={() => void openPlan(run.id)} />
      {said?.run === run.id ? (
        <Text size="sm" tone="danger">
          {said.texto}
        </Text>
      ) : null}
      {now.tareas.length === 0 ? null : (
        <Stack gap="none">
          {now.tareas.map((t) => (
            <Text key={t.key} size="sm" tone={t.tone} muted={t.tone === "neutral"} truncate>
              {`${t.mark} ${t.texto}`}
            </Text>
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
      {now.porPaso.length === 0 ? null : (
        <Stack gap="none">
          {now.porPaso.map((p) => (
            <Row key={p.label} justify="between">
              <Text size="xs" muted>
                {p.label}
              </Text>
              <Text size="xs" muted>
                {p.meta}
              </Text>
            </Row>
          ))}
        </Stack>
      )}
      <Row justify="between">
        {run.siguiente?.startsWith("https://") === true ? (
          <Link href={run.siguiente}>Abrir la PR</Link>
        ) : (
          <Text size="xs"> </Text>
        )}
        <Text size="xs" weight="semibold">
          {now.meta}
        </Text>
      </Row>
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
        <Stations run={run} />
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
        <Text size="xs" tone="danger">
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
