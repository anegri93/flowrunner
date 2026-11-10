// Las decisiones que espera un run, en una fila de botones: aprobar o pedir cambios al plan,
// reanudar o rehacer un run detenido, o responder su pregunta: que una sub-task lo arregle, arreglarlo
// a mano o seguir igual (ADR 0023). Las usan la pestaña de los runs y la del plan. Aprobar, reanudar,
// rehacer y arreglarlo a mano piden confirmación; pedir cambios, arreglar y seguir igual, el texto.
// Aprobar se habilita recién con el plan de ese run abierto en Orca (D3).
// Aparte, al pie de la tarjeta, abortar el run entero, también con confirmación.
import { atom, Button, Input, plugin, read, Row, set, Spinner, Stack, Text, update } from "orca";
import {
  canAbort,
  decisionsFor,
  describeExisting,
  existingChanges,
  fixUnits,
  planVersion,
  rerunPhase,
  type Decision,
  type Run,
} from "./runs";
import type { Snapshot } from "./protocol";

/** El plan que la persona abrió en Orca, por run: Aprobar se habilita recién con el plan visto (D3). */
const plansSeen = atom("planesVistos", {} as Record<string, string>, { persist: "plugin" });

export function markPlanSeen(run: Run): void {
  update(plansSeen, (m) => ({ ...m, [run.id]: planVersion(run) }));
}

export const planSeen = (run: Run): boolean => read(plansSeen)[run.id] === planVersion(run);

/**
 * Los runs que ya no están activos no necesitan recordar su plan. Una lectura con runs activos en otros
 * proyectos no los trae: entonces se olvidan solo los que dice cerrados. Sin nada que olvidar, no
 * escribe.
 */
export function forgetPlans(snapshot: Snapshot): void {
  const activos = snapshot.runs.map((r) => r.id);
  const cerrados = (snapshot.cerrados ?? []).map((r) => r.id);
  const complete = (snapshot.otros ?? 0) === 0;
  const seen = Object.entries(read(plansSeen));
  const kept = seen.filter(([id]) => (complete ? activos.includes(id) : !cerrados.includes(id)));
  if (kept.length < seen.length) set(plansSeen, Object.fromEntries(kept));
}

/** La decisión que espera confirmación, o el pedido de cambios que se está escribiendo. */
const pending = atom<{ run: string; decision: Decision } | null>(null);
const draft = atom("");
/**
 * Lo que dijo flowrunner, por run: lo que no salió, y lo que dijo al aprender, como «la PR sigue
 * abierta». Lo demás que sale se ve en el estado del run.
 */
const said = atom<{ run: string; ok: boolean; mensaje: string } | null>(null);
const sending = atom<string | null>(null);

async function decide(run: string, decision: Decision, after: () => Promise<void>): Promise<void> {
  set(pending, null);
  set(said, null);
  set(sending, run);
  try {
    const answer = await plugin.request("flowrunner.decidir", { run, decision });
    if (answer.ok) set(draft, "");
    // Lo que dice al aprender, y si Autofix commiteó algo, se muestran aunque salga.
    if (!answer.ok || decision.accion === "aprender" || decision.accion === "autofix")
      set(said, { run, ...answer });
  } catch (error) {
    set(said, { run, ok: false, mensaje: error instanceof Error ? error.message : String(error) });
  } finally {
    set(sending, null);
  }
  await after();
}

/** Las decisiones que se mandan con un texto de la persona: qué escribe y cómo se arma la decisión. */
function textFor(
  decision: Decision | undefined,
): { label: string; placeholder: string; decision: (text: string) => Decision } | undefined {
  switch (decision?.accion) {
    case "cambios":
      return {
        label: "Qué cambiar del plan",
        placeholder: "Qué corregir y qué mantener",
        decision: (motivo) => ({ accion: "cambios", motivo }),
      };
    case "arreglar": {
      const unidad = decision.unidad;
      return {
        label: `Qué tiene que corregir ${unidad}`,
        placeholder: "Qué está mal y qué tiene que quedar",
        decision: (instruccion) => ({ accion: "arreglar", unidad, instruccion }),
      };
    }
    case "aceptar":
      return {
        label: "Por qué seguir así; queda en la PR",
        placeholder: "Por qué este rojo no frena la entrega",
        decision: (motivo) => ({ accion: "aceptar", motivo }),
      };
    default:
      return undefined;
  }
}

export function Decisions({
  run,
  after,
  onPlan,
}: {
  run: Run;
  /** Lo que corre después de decidir: volver a leer los runs. */
  after: () => Promise<void>;
  /** Si está, ofrece abrir el plan en su pestaña. */
  onPlan?: () => void;
}) {
  const offered = decisionsFor(run);
  const waiting = read(pending);
  // Un Aprobar a medio confirmar vale solo para el plan sobre el que se tocó, y abierto: no para el de
  // un replan que llegó mientras tanto, aunque después se abra.
  const mine =
    waiting?.run === run.id &&
    (waiting.decision.accion !== "aprobar" ||
      (waiting.decision.plan === planVersion(run) && planSeen(run)))
      ? waiting.decision
      : undefined;
  const message = read(said);
  const note =
    message?.run === run.id ? (
      <Text size="sm" tone={message.ok ? "success" : "danger"}>
        {message.mensaje}
      </Text>
    ) : null;
  if (read(sending) === run.id) return <Spinner label="Enviando tu decisión" />;
  if (offered.length === 0) return note;
  const asked = textFor(mine);
  if (asked !== undefined) {
    const send = () => decide(run.id, asked.decision(read(draft)), after);
    return (
      <Stack gap="xs">
        <Input
          label={asked.label}
          placeholder={asked.placeholder}
          value={read(draft)}
          onChange={(v) => set(draft, v)}
          onSubmit={send}
        />
        <Row gap="xs">
          <Button size="sm" disabled={read(draft).trim() === ""} onPress={send}>
            Enviar
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(pending, null)}>
            Cancelar
          </Button>
        </Row>
      </Stack>
    );
  }
  const existing = existingChanges(run);
  if (mine?.accion === "aprobar" && existing.length > 0) {
    // Aprobar un plan que cambia lo que ya existe es aceptar esos cambios: se ven antes del botón.
    return (
      <Stack gap="xs">
        <Text size="sm" weight="semibold" tone="warning">
          {`⚠ El plan cambia lo que ya existe (${String(existing.length)})`}
        </Text>
        {existing.map((c) => (
          <Text key={`${c.donde}-${c.criterio}`} size="xs">
            {`• ${describeExisting(c)}`}
          </Text>
        ))}
        <Text size="xs" muted>
          Aprobar es aceptar estos cambios. Si alguno no va, cancelá y pedí cambios.
        </Text>
        <Row gap="xs">
          <Button
            size="sm"
            tone="warning"
            onPress={() =>
              decide(run.id, { accion: "aprobar", plan: mine.plan, aceptoCambios: true }, after)
            }
          >
            Acepto los cambios y apruebo
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
        ? "¿Aprobar el plan? Arranca implementar."
        : mine.accion === "reanudar"
          ? `¿Reanudar ${run.clave}?`
          : mine.accion === "autofix"
            ? `¿Autofix en ${run.clave}? Pasa el formateador y el lint y vuelve a verificar; si sigue en rojo, las sub-tasks lo corrigen solas.`
            : `¿Rehacer ${run.clave} desde ${mine.accion === "rehacer" ? mine.desde : ""}?`;
    return (
      <Stack gap="xs">
        <Text size="sm" weight="semibold">
          {question}
        </Text>
        <Row gap="xs">
          <Button size="sm" tone="success" onPress={() => decide(run.id, mine, after)}>
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
  const seen = planSeen(run);
  const desde = rerunPhase(run);
  const units = offered.includes("arreglar") ? fixUnits(run) : [];
  return (
    <Stack gap="xs">
      {note}
      {run.status === "detenido" && run.unidades !== undefined && run.unidades.length > 0 ? (
        <Text size="xs" muted>
          {`Parece ser de: ${run.unidades.join(", ")}`}
        </Text>
      ) : null}
      {offered.includes("aprobar") && existing.length > 0 ? (
        <Text size="xs" tone="warning">
          {`⚠ El plan cambia lo que ya existe (${String(existing.length)}): miralo antes de aprobar.`}
        </Text>
      ) : null}
      <Row gap="xs">
        {offered.includes("aprender") ? (
          <Button
            size="sm"
            icon="zap"
            onPress={() => decide(run.id, { accion: "aprender" }, after)}
          >
            Aprender ahora
          </Button>
        ) : null}
        {offered.includes("aprobar") ? (
          <Button
            size="sm"
            tone="success"
            icon="check"
            disabled={!seen}
            onPress={() => ask({ accion: "aprobar", plan: planVersion(run) })}
          >
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
            Cambios
          </Button>
        ) : null}
        {onPlan !== undefined && run.status === "esperando_aprobacion" ? (
          <Button size="sm" variant="ghost" icon="file-text" onPress={onPlan}>
            Plan
          </Button>
        ) : null}
        {units.map((unidad) => (
          <Button
            key={unidad}
            size="sm"
            icon="edit"
            onPress={() => ask({ accion: "arreglar", unidad, instruccion: "" })}
          >
            {`Arreglar ${unidad}`}
          </Button>
        ))}
        {offered.includes("autofix") ? (
          <Button size="sm" icon="zap" onPress={() => ask({ accion: "autofix" })}>
            Autofix
          </Button>
        ) : null}
        {offered.includes("aceptar") ? (
          <Button
            size="sm"
            variant="outline"
            onPress={() => ask({ accion: "aceptar", motivo: "" })}
          >
            Seguir igual
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
      {offered.includes("aprobar") && !seen ? (
        <Text size="xs" muted>
          Abrí el plan para poder aprobar.
        </Text>
      ) : null}
    </Stack>
  );
}

/** El run que espera que confirmes abortarlo, y lo que dijo flowrunner si no pudo. */
const aborting = atom<string | null>(null);
const abortNote = atom<{ run: string; mensaje: string } | null>(null);

/**
 * Abortar el run entero, al pie de su tarjeta y a la derecha: no es una decisión de la etapa actual. Pide
 * confirmación diciendo qué se pierde y qué queda.
 */
export function Abort({ run, after }: { run: Run; after: () => Promise<void> }) {
  if (!canAbort(run)) return null;
  if (read(sending) === run.id) return <Spinner label={`Abortando el run ${run.clave}`} />;
  const note = read(abortNote);
  if (read(aborting) === run.id) {
    const confirm = async () => {
      set(aborting, null);
      set(abortNote, null);
      set(sending, run.id);
      try {
        const answer = await plugin.request("flowrunner.decidir", {
          run: run.id,
          decision: { accion: "abortar" },
        });
        if (!answer.ok) set(abortNote, { run: run.id, mensaje: answer.mensaje });
      } catch (error) {
        set(abortNote, {
          run: run.id,
          mensaje: error instanceof Error ? error.message : String(error),
        });
      } finally {
        set(sending, null);
      }
      await after();
    };
    return (
      <Stack gap="xs">
        <Text size="sm" weight="semibold">
          {`¿Abortar el run ${run.clave}?`}
        </Text>
        <Text size="xs" muted>
          Corta lo que esté corriendo, en cualquier etapa, y borra sus worktrees. La rama y la PR
          quedan.
        </Text>
        <Row gap="xs" justify="end">
          <Button size="sm" tone="danger" onPress={confirm}>
            Sí, abortar el run
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(aborting, null)}>
            Cancelar
          </Button>
        </Row>
      </Stack>
    );
  }
  return (
    <Stack gap="xs">
      {note?.run === run.id ? (
        <Text size="xs" tone="danger">
          {note.mensaje}
        </Text>
      ) : null}
      <Row justify="end">
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          icon="stop"
          onPress={() => set(aborting, run.id)}
        >
          Abortar el run
        </Button>
      </Row>
    </Stack>
  );
}
