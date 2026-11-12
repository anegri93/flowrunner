// El panel sin DOM: el estado de lo que se ve, lo que pasa al tocar cada control y la lectura de los
// runs. `frame.ts` lo pega al DOM y a Orca; los tests lo manejan con una API simulada.
//
// El refresco no borra nada: si una lectura falla, quedan los runs anteriores con el error arriba.
// Nunca dos lecturas a la vez, y una que quedó vieja por un cambio de workspace se descarta.
import type { Openable, Outcome, Snapshot } from "./protocol";
import { planVersion, type Decision, type Run } from "./runs";
import {
  ESTADO_INICIAL,
  isOpen,
  pendingFor,
  textFor,
  vista,
  type Accion,
  type Estado,
} from "./vista";

/** Lo que el panel necesita de afuera: el worker, el storage del plugin, el navegador y la hora. */
export interface Api {
  /** Los runs; con `reciente`, el worker puede reusar lo que leyó hace poco (ver protocol.ts). */
  runs(reciente?: boolean): Promise<Snapshot>;
  abrir(run: string, que: Openable): Promise<Outcome>;
  decidir(run: string, decision: Decision): Promise<Outcome>;
  leer(key: string): Promise<unknown>;
  guardar(key: string, value: Readonly<Record<string, string | boolean>>): Promise<void>;
  externo(url: string): Promise<void>;
  ahora(): number;
}

/** Las claves del storage del plugin. */
export const PLANES_VISTOS = "planesVistos";
export const ABIERTOS = "abiertos";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Un objeto plano de valores de un tipo, o vacío: lo guardado puede venir de otra versión. */
function recordOf<T extends string | boolean>(
  value: unknown,
  kind: "string" | "boolean",
): Record<string, T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, T] => typeof entry[1] === kind),
  );
}

/**
 * Los runs que se cerraron entre dos lecturas: estaban entregados, esperando el merge, y ya no están
 * entre los activos. Al cambiar de proyecto en Orca, los del anterior dejan de verse sin cerrarse.
 */
export function closedSince(prev: Snapshot | null, next: Snapshot): string[] {
  if (prev === null) return [];
  if (prev.proyecto !== next.proyecto) return [];
  return prev.runs
    .filter((r) => r.status === "entregado" && !next.runs.some((n) => n.id === r.id))
    .map((r) => r.id);
}

/**
 * Los planes vistos que siguen valiendo. Una lectura con runs activos en otros proyectos no los trae:
 * entonces se olvidan solo los que dice cerrados.
 */
export function keptPlans(
  seen: Readonly<Record<string, string>>,
  snapshot: Snapshot,
): Record<string, string> {
  const activos = snapshot.runs.map((r) => r.id);
  const cerrados = (snapshot.cerrados ?? []).map((r) => r.id);
  const complete = (snapshot.otros ?? 0) === 0;
  return Object.fromEntries(
    Object.entries(seen).filter(([id]) =>
      complete ? activos.includes(id) : !cerrados.includes(id),
    ),
  );
}

export class Panel {
  #e: Estado = ESTADO_INICIAL;
  #reading = false;
  /** Sube con cada cambio de workspace: una lectura pedida antes ya no es de lo que se ve. */
  #generation = 0;
  /** La próxima lectura es por un cambio de proyecto: alcanza con la lectura reciente del worker. */
  #reciente = false;
  #workspace: string | undefined;
  readonly #api: Api;
  readonly #changed: () => void;

  constructor(api: Api, changed: () => void = () => undefined) {
    this.#api = api;
    this.#changed = changed;
  }

  get estado(): Estado {
    return this.#e;
  }

  html(): string {
    return vista({ ...this.#e, ahora: this.#api.ahora() });
  }

  #set(patch: Partial<Estado>): void {
    this.#e = { ...this.#e, ...patch };
    this.#changed();
  }

  async #save(key: string, value: Readonly<Record<string, string | boolean>>): Promise<void> {
    try {
      await this.#api.guardar(key, value);
    } catch (error) {
      // Lo que se ve ya cambió; perderlo solo obliga a abrir de nuevo el plan después de recargar.
      console.error(`flowrunner: no se pudo guardar ${key}: ${message(error)}`);
    }
  }

  /** Lo guardado de una sesión anterior: los planes abiertos y las tarjetas abiertas o cerradas. */
  async cargar(): Promise<void> {
    const [vistos, abiertos] = await Promise.all([
      this.#api.leer(PLANES_VISTOS).catch(() => null),
      this.#api.leer(ABIERTOS).catch(() => null),
    ]);
    this.#set({
      planesVistos: recordOf<string>(vistos, "string"),
      abiertos: recordOf<boolean>(abiertos, "boolean"),
    });
  }

  #run(id: string): Run | undefined {
    return (
      this.#e.snapshot?.runs.find((r) => r.id === id) ??
      this.#e.snapshot?.cerrados?.find((r) => r.id === id)
    );
  }

  /** Lee los runs. Una lectura que no cambió nada no vuelve a dibujar. */
  async refresh(): Promise<void> {
    if (this.#reading) return;
    this.#reading = true;
    const asked = this.#generation;
    const reciente = this.#reciente;
    this.#reciente = false;
    try {
      const next = await this.#api.runs(reciente);
      if (asked !== this.#generation) return;
      const prev = this.#e.snapshot;
      if (next.error === undefined)
        for (const id of closedSince(prev, next)) void this.#open(id, { tipo: "informe" });
      const shown =
        next.error !== undefined && prev !== null ? { ...prev, error: next.error } : next;
      const same =
        prev !== null && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...shown, at: 0 });
      if (!same) this.#set({ snapshot: shown });
      // Los runs que dejaron de estar activos no necesitan recordar qué plan se abrió.
      if (next.error === undefined) {
        const kept = keptPlans(this.#e.planesVistos, next);
        if (Object.keys(kept).length < Object.keys(this.#e.planesVistos).length) {
          this.#set({ planesVistos: kept });
          await this.#save(PLANES_VISTOS, kept);
        }
      }
    } catch (error) {
      if (asked !== this.#generation) return;
      const prev = this.#e.snapshot;
      this.#set({
        snapshot: {
          runs: prev?.runs ?? [],
          ...(prev?.cerrados === undefined ? {} : { cerrados: prev.cerrados }),
          error: message(error),
          at: this.#api.ahora(),
        },
      });
    } finally {
      this.#reading = false;
      if (asked !== this.#generation) void this.refresh();
    }
  }

  /**
   * Al cambiar de workspace en Orca vuelve a la nave y lee enseguida, sin mostrar los runs del
   * anterior. El evento también llega cuando cambian sus terminales: eso no cuenta como cambio. El
   * primer aviso es el workspace de ahora, no un cambio.
   */
  async workspace(context: { displayName: string; branch: string } | null): Promise<void> {
    const key = context === null ? "" : `${context.displayName}\n${context.branch}`;
    const changed = this.#workspace !== undefined && key !== this.#workspace;
    this.#workspace = key;
    if (!changed) return;
    this.#generation += 1;
    this.#reciente = true;
    this.#set({ snapshot: null });
    await this.refresh();
  }

  /** Abre un archivo como pestaña de Orca; si no, dice por qué en su run. Abrir el plan lo marca visto. */
  async #open(run: string, que: Openable): Promise<void> {
    this.#set({ aviso: null });
    try {
      const answer = await this.#api.abrir(run, que);
      if (!answer.ok) {
        this.#set({ aviso: { run, texto: answer.mensaje } });
        return;
      }
      const shown = this.#run(run);
      if (que.tipo === "plan" && shown !== undefined) {
        const planesVistos = { ...this.#e.planesVistos, [run]: planVersion(shown) };
        this.#set({ planesVistos });
        await this.#save(PLANES_VISTOS, planesVistos);
      }
    } catch (error) {
      this.#set({ aviso: { run, texto: `No se pudo abrir: ${message(error)}` } });
    }
  }

  async #decide(run: string, decision: Decision): Promise<void> {
    this.#set({ pendiente: null, dicho: null, enviando: run });
    try {
      const answer = await this.#api.decidir(run, decision);
      if (answer.ok) this.#set({ borrador: "" });
      // Lo que dice al aprender, y si Autofix commiteó algo, se muestran aunque salga.
      if (!answer.ok || decision.accion === "aprender" || decision.accion === "autofix")
        this.#set({ dicho: { run, ...answer } });
    } catch (error) {
      this.#set({ dicho: { run, ok: false, mensaje: message(error) } });
    } finally {
      this.#set({ enviando: null });
    }
    await this.refresh();
  }

  async #abort(run: string): Promise<void> {
    // `abortando` sigue mientras se manda: así la tarjeta dice «Abortando», no «Enviando tu decisión».
    this.#set({ avisoAbortar: null, enviando: run });
    try {
      const answer = await this.#api.decidir(run, { accion: "abortar" });
      if (!answer.ok) this.#set({ avisoAbortar: { run, mensaje: answer.mensaje } });
    } catch (error) {
      this.#set({ avisoAbortar: { run, mensaje: message(error) } });
    } finally {
      this.#set({ enviando: null, abortando: null });
    }
    await this.refresh();
  }

  /** Lo que la persona escribe en el campo de texto: no se manda hasta Enviar o Enter. */
  escribir(texto: string): void {
    this.#set({ borrador: texto });
  }

  /** Lo que pasa al tocar un control. */
  async tocar(accion: Accion): Promise<void> {
    // Elegir algo cierra el menú ⋯, sea o no del menú.
    if (accion.t !== "menu" && this.#e.menu !== null) this.#set({ menu: null });
    switch (accion.t) {
      case "menu":
        this.#set({ menu: this.#e.menu === accion.run ? null : accion.run });
        return;
      case "cerrarMenu":
        return;
      case "motivo":
        this.#set({
          motivos: { ...this.#e.motivos, [accion.run]: this.#e.motivos[accion.run] !== true },
        });
        return;
      case "alternar": {
        const run = this.#run(accion.run);
        if (run === undefined) return;
        // Un nodo del recorrido se guarda como `<run>:<clave>`; su estado actual viene en la acción.
        const abiertos =
          accion.nodo === undefined
            ? { ...this.#e.abiertos, [run.id]: !isOpen(this.#e, run) }
            : { ...this.#e.abiertos, [`${run.id}:${accion.nodo}`]: accion.abierto !== true };
        this.#set({ abiertos });
        await this.#save(ABIERTOS, abiertos);
        return;
      }
      case "cerrados":
        this.#set({ cerradosAbiertos: !this.#e.cerradosAbiertos });
        return;
      case "alternarCerrado":
        this.#set({
          cerradoAbierto: {
            ...this.#e.cerradoAbierto,
            [accion.run]: this.#e.cerradoAbierto[accion.run] !== true,
          },
        });
        return;
      case "abrir":
        await this.#open(accion.run, accion.que);
        return;
      case "externo":
        await this.#api.externo(accion.url);
        return;
      case "preguntar":
        this.#set({ pendiente: { run: accion.run, decision: accion.decision } });
        return;
      case "cancelar":
        this.#set({ pendiente: null });
        return;
      case "decidir":
        await this.#decide(accion.run, accion.decision);
        return;
      case "enviarTexto": {
        const run = this.#run(accion.run);
        const asked = run === undefined ? undefined : textFor(pendingFor(this.#e, run));
        if (asked === undefined || this.#e.borrador.trim() === "") return;
        await this.#decide(accion.run, asked.decision(this.#e.borrador));
        return;
      }
      case "abortar":
        this.#set({ abortando: accion.run });
        return;
      case "noAbortar":
        this.#set({ abortando: null });
        return;
      case "confirmarAbortar":
        await this.#abort(accion.run);
        return;
    }
  }
}
