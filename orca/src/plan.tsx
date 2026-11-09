// La pestaña del plan: el plan entero del run que la persona eligió con «Plan», o del más reciente
// que espera aprobación, con las decisiones arriba. Se abre desde la pestaña de los runs.
import {
  EmptyState,
  Heading,
  plugin,
  read,
  set,
  atom,
  Spinner,
  Stack,
  Text,
  type PanelContext,
} from "orca";
import { Decisions } from "./decisiones";
import type { PlanView, Run } from "./runs";
import { headlineOf } from "./runs";

const REFRESH_MS = 5_000;

const current = atom<{ run?: Run; plan?: PlanView; error?: string } | null>(null);
let reading = false;

/** Lee el plan sin borrar el anterior: una lectura que falla deja lo que se veía. */
async function load(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    const next = await plugin.request("flowrunner.planActual");
    const prev = read(current);
    if (next.error !== undefined && prev?.run !== undefined)
      set(current, { ...prev, error: next.error });
    else if (JSON.stringify(prev) !== JSON.stringify(next)) set(current, next);
  } finally {
    reading = false;
  }
}

export function setup(ctx: PanelContext): void {
  void load();
  const timer = setInterval(() => {
    if (read(ctx.visible)) void load();
  }, REFRESH_MS);
  ctx.signal.addEventListener("abort", () => clearInterval(timer));
}

export default function Plan() {
  const data = read(current);
  if (data === null) return <Spinner label="Leyendo el plan" />;
  const { run, plan, error } = data;
  if (run === undefined || plan === undefined) {
    return (
      <Stack gap="sm">
        {error === undefined ? null : (
          <Text size="xs" tone="danger">
            {error}
          </Text>
        )}
        <EmptyState
          title="Ningún plan te espera"
          description="Cuando un plan espere tu aprobación, se ve acá."
        />
      </Stack>
    );
  }
  const headline = headlineOf(run);
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Heading>{`${run.clave} · ${run.titulo}`}</Heading>
        <Text weight="semibold" tone={headline.tone}>
          {`${headline.emoji} ${headline.texto}`}
        </Text>
        <Decisions run={run} after={load} />
      </Stack>
      <Stack gap="none">
        <Text size="sm" weight="semibold">
          {`${String(plan.subtareas.length)} sub-tasks · ${String(plan.criterios)} criterios`}
        </Text>
        {plan.subtareas.map((t) => (
          <Text key={t.id} size="sm">
            {`${t.id} · ${t.titulo}`}
          </Text>
        ))}
      </Stack>
      {plan.cambios.length === 0 ? null : (
        <Stack gap="none">
          <Text size="sm" weight="semibold" tone="warning">
            Contra el plan anterior
          </Text>
          {plan.cambios.map((c) => (
            <Text key={c} size="sm" tone="warning">
              {c}
            </Text>
          ))}
        </Stack>
      )}
      <Stack gap="xs">
        {plan.lineas.map((line, i) =>
          line.startsWith("#") ? (
            <Text key={String(i)} weight="semibold">
              {line.replace(/^#+\s*/, "")}
            </Text>
          ) : (
            <Text key={String(i)} size="sm">
              {line}
            </Text>
          ),
        )}
      </Stack>
      {error === undefined ? null : (
        <Text size="xs" tone="danger">
          {error}
        </Text>
      )}
    </Stack>
  );
}
