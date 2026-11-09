// Las decisiones que espera un run, en una fila de botones: aprobar o pedir cambios al plan,
// reanudar o rehacer un run detenido. Las usan la pestaña de los runs y la del plan. Aprobar,
// reanudar y rehacer piden confirmación; pedir cambios, el motivo.
import { atom, Button, Input, plugin, read, Row, set, Spinner, Stack, Text } from "orca";
import { decisionsFor, rerunPhase, type Decision, type Run } from "./runs";

/** La decisión que espera confirmación, o el pedido de cambios que se está escribiendo. */
const pending = atom<{ run: string; decision: Decision } | null>(null);
const draft = atom("");
/** Lo que no salió: el mensaje de flowrunner, por run. Lo que sale se ve en el estado del run. */
const failed = atom<{ run: string; mensaje: string } | null>(null);
const sending = atom<string | null>(null);

async function decide(run: string, decision: Decision, after: () => Promise<void>): Promise<void> {
  set(pending, null);
  set(failed, null);
  set(sending, run);
  try {
    const answer = await plugin.request("flowrunner.decidir", { run, decision });
    if (answer.ok) set(draft, "");
    else set(failed, { run, mensaje: answer.mensaje });
  } catch (error) {
    set(failed, { run, mensaje: error instanceof Error ? error.message : String(error) });
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
  const error = read(failed);
  const note =
    error?.run === run.id ? (
      <Text size="sm" tone="danger">
        {error.mensaje}
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
