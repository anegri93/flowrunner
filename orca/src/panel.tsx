// La pestaña de los runs en la barra derecha de Orca, al estilo de flowindex. Cada run es una
// tarjeta: su estado, el título, el tiempo, y las nueve etapas del flujo en una lista con sus
// intentos y su tiempo. La etapa que trabaja gira, y debajo dice qué está haciendo, con las
// decisiones que espera. Los más recientes arriba; los terminados muestran solo la etapa actual
// hasta que se abren. El refresco no borra nada: si una lectura falla, queda la anterior.
// Sin paso de build: Orca quita los tipos y compila el JSX al cargarlo.
import {
  atom,
  Badge,
  Card,
  EmptyState,
  IconButton,
  Link,
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
import { Abort, Decisions } from "./decisiones";
import type { Openable, Snapshot } from "./protocol";
import {
  canAbort,
  clock,
  decisionsFor,
  isFinished,
  needsYou,
  nowOf,
  runChip,
  sortRuns,
  stageRows,
  tail,
  type Run,
  type StageRow,
} from "./runs";

const REFRESH_MS = 3_000;

const snapshot = atom<Snapshot | null>(null);
/** Runs que la persona abrió o cerró a mano; el resto sigue el default. */
const toggled = atom("abiertos", {} as Record<string, boolean>, { persist: "plugin" });
const notice = atom<{ run: string; texto: string } | null>(null);

let reading = false;
/**
 * Los runs que se cerraron entre dos lecturas: estaban entregados, esperando el merge, y ya no están
 * entre los activos. Al cerrarse, su informe se abre solo.
 */
function closedSince(prev: Snapshot | null, next: Snapshot): string[] {
  // Una vez por run: en la lectura siguiente, el run ya no está en la anterior.
  if (prev === null) return [];
  // Al cambiar de proyecto en Orca, los runs del anterior dejan de verse sin haberse cerrado.
  if (prev.proyecto !== next.proyecto) return [];
  return prev.runs
    .filter((r) => r.status === "entregado" && !next.runs.some((n) => n.id === r.id))
    .map((r) => r.id);
}

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
    if (next.error === undefined)
      for (const id of closedSince(prev, next)) void open(id, { tipo: "informe" });
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

/** Abre los pasos, una sub-task, el plan o el informe como pestaña de Orca; si no, dice por qué. */
async function open(run: string, que: Openable): Promise<void> {
  set(notice, null);
  try {
    const answer = await plugin.request("flowrunner.abrir", { run, que });
    if (!answer.ok) set(notice, { run, texto: answer.mensaje });
  } catch (error) {
    set(notice, { run, texto: `No se pudo abrir: ${String(error)}` });
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

/** Lo que pasa en la etapa actual: su estado, las sub-tasks, qué hace la sesión y las decisiones. */
function Current({ run, row }: { run: Run; row: StageRow }) {
  const now = nowOf(run);
  const said = read(notice);
  return (
    <Stack gap="xs">
      {run.motivo === undefined ? null : (
        <Text size="xs" tone="danger">
          {tail(run.motivo, 600)}
        </Text>
      )}
      {now.detalle === undefined || run.motivo !== undefined ? null : (
        <Text size="xs" tone="warning">
          {now.detalle.length > 280 ? `${now.detalle.slice(0, 280)}…` : now.detalle}
        </Text>
      )}
      {now.tareas.map((t) => (
        <Text key={t.key} size="xs" tone={t.tone} muted={t.tone === "neutral"} truncate>
          <Link onPress={() => open(run.id, { tipo: "unidad", unidad: t.key })}>
            {`${t.mark} ${t.texto}`}
          </Link>
        </Text>
      ))}
      {now.actividad.map((a) => (
        <Row key={a.sesion} justify="between" align="center">
          <Text
            size="xs"
            tone={a.ahora === undefined ? "neutral" : "accent"}
            muted={a.ahora === undefined}
            truncate
          >
            {a.ahora ?? a.texto}
          </Text>
          <IconButton
            icon="file-text"
            label={`Pasos de ${a.sesion}`}
            variant="ghost"
            size="sm"
            onPress={() => open(run.id, { tipo: "pasos", sesion: a.sesion })}
          />
        </Row>
      ))}
      {decisionsFor(run).length > 0 ? (
        <Decisions run={run} after={refresh} onPlan={() => void open(run.id, { tipo: "plan" })} />
      ) : null}
      {said?.run === run.id ? (
        <Text size="xs" tone="danger">
          {said.texto}
        </Text>
      ) : null}
    </Stack>
  );
}

/** El run ya tiene plan: planificar terminó, aunque después se haya aprobado o corregido. */
const hasPlan = (run: Run) => run.fases.some((p) => p.fase === "planificar" && p.estado === "ok");

/** Una etapa: su estado, su nombre, sus intentos y su tiempo. La que trabaja gira. Tocar una etapa
 * que ya arrancó abre su detalle; tocar «Aprobar» abre el plan, el que espera o el que se aprobó. */
function Stage({ run, row }: { run: Run; row: StageRow }) {
  const pending = row.estado === "pendiente";
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Row gap="sm" align="center">
          {row.estado === "corriendo" ? (
            <Spinner label={`${row.nombre}: trabajando`} labelHidden />
          ) : (
            <Text tone={row.tone} muted={pending}>
              {row.mark}
            </Text>
          )}
          {row.fase === "aprobar" && hasPlan(run) ? (
            <Link onPress={() => open(run.id, { tipo: "plan" })}>{row.nombre}</Link>
          ) : pending ? (
            <Text muted>{row.nombre}</Text>
          ) : (
            <Text weight={row.actual ? "semibold" : "regular"}>
              <Link onPress={() => open(run.id, { tipo: "etapa", fase: row.fase })}>
                {row.nombre}
              </Link>
            </Text>
          )}
          {row.actual ? (
            <Text size="xs" tone={row.tone}>
              {row.texto}
            </Text>
          ) : null}
        </Row>
        <Text size="xs" muted>
          {row.meta}
        </Text>
      </Row>
      {row.actual ? <Current run={run} row={row} /> : null}
    </Stack>
  );
}

function RunCard({ run }: { run: Run }) {
  const open = isOpen(run);
  const chip = runChip(run);
  const rows = stageRows(run);
  const shown = open ? rows : rows.filter((r) => r.actual);
  const footer = nowOf(run).meta;
  return (
    <Card>
      <Stack gap="sm">
        <Row justify="between" align="center">
          <Badge tone={chip.tone}>{chip.texto}</Badge>
          <IconButton
            icon={open ? "collapse" : "expand"}
            label={open ? `Ocultar las etapas de ${run.clave}` : `Ver las etapas de ${run.clave}`}
            variant="ghost"
            size="sm"
            onPress={() => update(toggled, (m) => ({ ...m, [run.id]: !open }))}
          />
        </Row>
        <Stack gap="none">
          <Text weight="semibold">{run.titulo}</Text>
          <Text size="xs" muted>
            {`${run.clave} · ${run.id}`}
          </Text>
        </Stack>
        <Stack gap="none">
          <Text size="xs" muted>
            TIEMPO
          </Text>
          <Text weight="semibold">{clock(run.segundos) ?? "–"}</Text>
        </Stack>
        <Separator />
        {shown.map((row) => (
          <Stage key={row.fase} run={run} row={row} />
        ))}
        <Row justify="between">
          {run.siguiente?.startsWith("https://") === true ? (
            <Link href={run.siguiente}>Abrir la PR</Link>
          ) : (
            <Text size="xs"> </Text>
          )}
          <Text size="xs" muted>
            {footer}
          </Text>
        </Row>
        {canAbort(run) ? <Separator /> : null}
        <Abort run={run} after={refresh} />
      </Stack>
    </Card>
  );
}

export default function Panel() {
  const snap = read(snapshot);
  if (snap === null) return <Spinner label="Leyendo los runs de flowrunner" />;
  const runs = sortRuns(snap.runs);
  const others = snap.otros ?? 0;
  const elsewhere =
    others === 0
      ? null
      : `${String(others)} ${others === 1 ? "run activo" : "runs activos"} en otros proyectos: cambiá de proyecto en Orca para ${others === 1 ? "verlo" : "verlos"}.`;
  return (
    <Stack gap="md">
      {snap.proyecto === undefined ? null : (
        <Text size="xs" muted>
          {snap.proyecto}
        </Text>
      )}
      {snap.error === undefined ? null : (
        <Text size="xs" tone="danger">
          No se pudo leer flowrunner: {snap.error}
        </Text>
      )}
      {runs.length === 0 && snap.error === undefined ? (
        <EmptyState
          title={
            snap.proyecto === undefined
              ? "No hay runs activos"
              : `No hay runs activos en ${snap.proyecto}`
          }
          description={
            elsewhere ?? "Cuando lances una feature desde Claude Code, su progreso aparece acá."
          }
        />
      ) : (
        runs.map((run) => <RunCard key={run.id} run={run} />)
      )}
      {runs.length > 0 && elsewhere !== null ? (
        <Text size="xs" muted>
          {elsewhere}
        </Text>
      ) : null}
    </Stack>
  );
}
