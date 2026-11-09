// El panel de flowrunner en la barra derecha de Orca: cada run activo con sus fases, sub-tasks y
// sesiones, como `flowrunner watch`. Tocar una sesión muestra sus pasos. Sin paso de build: Orca
// quita los tipos y compila el JSX al cargarlo.
import {
  atom,
  Button,
  Card,
  Code,
  EmptyState,
  Link,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  type PanelContext,
} from "orca";
import type { Snapshot, Steps } from "./protocol";
import { runRows, runSummary, type Run } from "./runs";

const REFRESH_MS = 3_000;
/** Lo último de los pasos de una sesión: lo de arriba ya pasó. */
const STEPS_CHARS = 6_000;

const snapshot = atom<Snapshot | null>(null);
const steps = atom<(Steps & { run: string }) | null>(null);
const loadingSteps = atom<string | null>(null);

async function refresh(): Promise<void> {
  set(snapshot, await plugin.request("flowrunner.runs"));
}

async function showSteps(run: string, sesion: string): Promise<void> {
  set(loadingSteps, sesion);
  try {
    set(steps, { run, ...(await plugin.request("flowrunner.pasos", { run, sesion })) });
  } catch (error) {
    set(steps, { run, sesion, texto: `No se pudieron leer los pasos: ${String(error)}` });
  } finally {
    set(loadingSteps, null);
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

function RunCard({ run }: { run: Run }) {
  return (
    <Card title={`${run.clave} · ${run.titulo}`} description={runSummary(run)}>
      <Stack gap="sm">
        {run.motivo === undefined ? null : <Text tone="danger">{run.motivo}</Text>}
        {run.siguiente === undefined ? null : run.siguiente.startsWith("https://") ? (
          <Row>
            <Link href={run.siguiente}>Abrir la PR</Link>
          </Row>
        ) : (
          <Code>{run.siguiente}</Code>
        )}
        <List label={`Fases de ${run.clave}`}>
          {runRows(run).map((row) => (
            <ListItem
              key={row.key}
              title={row.title}
              description={row.description}
              icon={row.icon}
              current={read(steps)?.run === run.id && read(steps)?.sesion === row.sesion}
              {...(row.sesion === undefined
                ? {}
                : { onPress: () => showSteps(run.id, row.sesion ?? "") })}
            />
          ))}
        </List>
      </Stack>
    </Card>
  );
}

export default function Panel() {
  const snap = read(snapshot);
  const shown = read(steps);
  const loading = read(loadingSteps);
  if (snap === null) return <Spinner label="Leyendo los runs de flowrunner" />;
  return (
    <Stack gap="md">
      {snap.error === undefined ? null : (
        <Text tone="danger">No se pudo leer flowrunner: {snap.error}</Text>
      )}
      {loading === null ? null : <Spinner label={`Leyendo los pasos de ${loading}`} />}
      {shown === null ? null : (
        <Card title={`Pasos de ${shown.sesion}`}>
          <Stack gap="sm">
            <Code block>
              {shown.texto.length > STEPS_CHARS
                ? `…${shown.texto.slice(-STEPS_CHARS)}`
                : shown.texto || "(sin pasos todavía)"}
            </Code>
            <Row>
              <Button variant="ghost" onPress={() => set(steps, null)}>
                Cerrar
              </Button>
            </Row>
          </Stack>
        </Card>
      )}
      {snap.runs.length === 0 && snap.error === undefined ? (
        <EmptyState
          title="No hay runs activos"
          description="Cuando lances una feature desde Claude Code, su progreso aparece acá."
        />
      ) : (
        snap.runs.map((run) => <RunCard key={run.id} run={run} />)
      )}
    </Stack>
  );
}
