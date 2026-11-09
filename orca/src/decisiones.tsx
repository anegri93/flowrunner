// Las decisiones que espera un run, en una fila de botones: aprobar o pedir cambios al plan,
// reanudar o rehacer un run detenido. Las usan la pestaña de los runs y la del plan. Aprobar,
// reanudar y rehacer piden confirmación; pedir cambios, el motivo. Aparte, al pie de la tarjeta,
// abortar el run entero, también con confirmación.
import { atom, Button, Input, plugin, read, Row, set, Spinner, Stack, Text } from "orca";
import { canAbort, decisionsFor, rerunPhase, type Decision, type Run } from "./runs";

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
    if (!answer.ok || decision.accion === "aprender") set(said, { run, ...answer });
  } catch (error) {
    set(said, { run, ok: false, mensaje: error instanceof Error ? error.message : String(error) });
  } finally {
    set(sending, null);
  }
  await after();
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
  const mine = waiting?.run === run.id ? waiting.decision : undefined;
  const message = read(said);
  const note =
    message?.run === run.id ? (
      <Text size="sm" tone={message.ok ? "success" : "danger"}>
        {message.mensaje}
      </Text>
    ) : null;
  if (read(sending) === run.id) return <Spinner label="Enviando tu decisión" />;
  if (offered.length === 0) return note;
  if (mine?.accion === "cambios") {
    const send = () => decide(run.id, { accion: "cambios", motivo: read(draft) }, after);
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
            Enviar
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
  const desde = rerunPhase(run);
  return (
    <Stack gap="xs">
      {note}
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
            Cambios
          </Button>
        ) : null}
        {onPlan !== undefined && run.status === "esperando_aprobacion" ? (
          <Button size="sm" variant="ghost" icon="file-text" onPress={onPlan}>
            Plan
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
    </Stack>
  );
}

/** El run que espera que confirmes abortarlo, y lo que dijo flowrunner si no pudo. */
const aborting = atom<string | null>(null);
const abortNote = atom<{ run: string; mensaje: string } | null>(null);

/**
 * Abortar el run entero, al pie de su tarjeta: no es una decisión de la etapa actual. Pide
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
        <Row gap="xs">
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
      <Button
        size="sm"
        variant="ghost"
        tone="danger"
        icon="stop"
        onPress={() => set(aborting, run.id)}
      >
        Abortar el run
      </Button>
    </Stack>
  );
}
