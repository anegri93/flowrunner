// La política de comandos de Bash: cada tramo de un comando se evalúa por separado contra lo que la
// sesión puede leer, correr y escribir (PR 03, VF-6: 135 rechazos, 100 de solo lectura).
//
// El parser imita a `sh -c`, que es como corre cada comando (`scrubCommand`). Ante algo que no sabe
// leer, rechaza: el costo es un turno, no una puerta abierta.
import { matchesGlob } from "node:path";
import { SECRET_ENV_VARS } from "../agent/env.ts";
import {
  checkReadPath,
  checkSearchPath,
  checkWritePath,
  type Scope,
  type Verdict,
} from "./rules.ts";

export interface Comandos {
  /** Pasan con argumentos de más detrás: los comandos de los criterios y el typecheck. */
  readonly ampliables: readonly string[];
  /** Pasan solo idénticos: instalar las dependencias declaradas. */
  readonly exactos: readonly string[];
  /** lint_fix y format del repo: su programa, sobre archivos del alcance. */
  readonly fixers: readonly string[];
}

export const SIN_COMANDOS: Comandos = { ampliables: [], exactos: [], fixers: [] };

export interface Palabra {
  readonly texto: string;
  /** Alguna parte iba entre comillas o escapada con `\`. */
  readonly citada: boolean;
  /** Tiene `*`, `?` o `[` sin comillas: el shell la expande. */
  readonly comodin: boolean;
  /** El nombre, si la palabra es `NOMBRE=valor` con el nombre sin comillas: al principio del tramo, una asignación. */
  readonly asigna?: string;
}
export interface Redireccion {
  readonly fd: string;
  readonly op: ">" | ">>" | "<";
  /** El archivo, o `&N` cuando duplica un descriptor (`2>&1`). */
  readonly destino: string;
  readonly comodin: boolean;
}
export interface Tramo {
  readonly palabras: readonly Palabra[];
  readonly redirecciones: readonly Redireccion[];
  /** Recibe la salida de otro por `|`. */
  readonly desdePipe: boolean;
}

const OK: Verdict = { ok: true };
const no = (motivo: string): Verdict => ({ ok: false, motivo });

const MOTIVO = {
  sustitucion: "`$( )`, backticks y `<( )` no se usan: corré cada comando por separado",
  variable: "no se usan variables de shell (`$X`): escribí el valor o la ruta tal cual",
  heredoc: "no se usan heredocs (`<<`): para escribir un archivo usá Write o Edit",
  llaves: "no se usan `( )` ni `{ }` del shell: encadená con `;` o `&&`",
  fondo: "no se corre nada en segundo plano (`&`)",
  tilde: "`~` apunta fuera del worktree: usá rutas relativas a la raíz del worktree",
  sintaxis: "no pude leer el comando: revisá las comillas y los operadores",
  credencial: (nombre: string) => `\`${nombre}\` es una credencial: no se pasa a los comandos`,
  cd: "los comandos corren en la raíz del worktree y `cd` no se usa: nombrá las rutas desde la raíz, como `ls app/src`",
  verify:
    "el verify del repo lo corre verificar, sobre la rama con todas las sub-tasks integradas: corré los comandos de tus criterios",
  git: (sub: string) =>
    `\`git ${sub}\` no está permitido: flowrunner commitea por vos. Para mirar: git status, log, diff, show, grep o blame`,
  script: (p: string) =>
    `\`${p}\` corre un script ad hoc, que no se puede revisar por partes: para mirar usá Read o Grep, y para cambiar, Write o Edit`,
  red: (p: string) => `\`${p}\` usa la red, y una sub-task no sale a la red`,
  archivos: (p: string) =>
    `\`${p}\` cambia archivos por fuera de las herramientas: para crear o cambiar usá Write o Edit`,
  sedEscribe:
    "`sed -i` y los scripts de sed que escriben no se usan: para cambiar un archivo usá Edit; para mirar, `sed -n 10,40p archivo`",
  sedSinN: "sed solo se usa para mirar, con `-n`: `sed -n 10,40p archivo`",
  comodin:
    "en un comando que escribe, nombrá cada ruta sin comodines y citala con comillas simples si tiene corchetes o paréntesis",
  fixerSinArchivos: (fixer: string) =>
    `nombrá los archivos de tu alcance que querés pasar por \`${fixer}\``,
  opcionFixer: (opcion: string, fixer: string) =>
    `\`${opcion}\` no se usa con \`${fixer}\`: la configuración la pone el repo`,
  escribeFuera: (ruta: string, motivo: string) => `el comando escribe en ${ruta}: ${motivo}`,
  noPermitido: (p: string, c: Comandos) =>
    `\`${p}\` no está entre los comandos permitidos. ${describeComandos(c)}`,
} as const;

/** Lo que sigue a un `$` y lo vuelve una variable: `$X`, `${X}`, `$1`, `$?`… */
const VARIABLE = /[A-Za-z_{0-9@*#?!$-]/;
const ASIGNACION = /^([A-Za-z_][A-Za-z0-9_]*)=/;

type Parsed = { ok: true; tramos: Tramo[] } | { ok: false; motivo: string };

/** Parte el comando en tramos, o dice por qué no se puede (motivo de la tabla de la spec). */
export function parseCommand(command: string): Parsed {
  const tramos: Tramo[] = [];
  let palabras: Palabra[] = [];
  let redirecciones: Redireccion[] = [];
  let desdePipe = false;
  let ultimoSeparador = "";
  // La palabra en curso. En un objeto: las funciones de abajo la cambian, y el control de flujo de
  // TypeScript no ve esos cambios en variables sueltas.
  const w = {
    texto: "",
    enCurso: false,
    citada: false,
    comodin: false,
    /** Lo que lleva sin comillas desde el principio: decide si es una asignación. */
    prefijo: "",
    soloSinComillas: true,
  };
  let pendiente: { fd: string; op: Redireccion["op"]; dup: boolean } | undefined;

  const limpiar = () => {
    w.texto = "";
    w.enCurso = false;
    w.citada = false;
    w.comodin = false;
    w.prefijo = "";
    w.soloSinComillas = true;
  };
  /** Cierra la palabra en curso. Devuelve un motivo si no se puede. */
  const cerrarPalabra = (): string | undefined => {
    if (!w.enCurso) return undefined;
    if (pendiente !== undefined) {
      // `> '&x'` escribe en un archivo llamado `&x`; acá `&` quiere decir duplicar.
      if (!pendiente.dup && w.texto.startsWith("&")) return MOTIVO.sintaxis;
      redirecciones.push({
        fd: pendiente.fd,
        op: pendiente.op,
        destino: `${pendiente.dup ? "&" : ""}${w.texto}`,
        comodin: w.comodin,
      });
      pendiente = undefined;
    } else {
      const asigna = ASIGNACION.exec(w.prefijo)?.[1];
      palabras.push({
        texto: w.texto,
        citada: w.citada,
        comodin: w.comodin,
        ...(asigna === undefined ? {} : { asigna }),
      });
    }
    limpiar();
    return undefined;
  };
  const cerrarTramo = (separador: string): string | undefined => {
    const error = cerrarPalabra();
    if (error !== undefined) return error;
    if (pendiente !== undefined) return MOTIVO.sintaxis;
    if (palabras.length === 0 && redirecciones.length === 0) {
      // Las líneas en blanco no cuentan; un `;`, `&&` o `|` sin comando antes, sí.
      if (separador === "\n") return undefined;
      if (separador === "fin")
        return ["&&", "||", "|"].includes(ultimoSeparador) ? MOTIVO.sintaxis : undefined;
      return MOTIVO.sintaxis;
    }
    tramos.push({ palabras, redirecciones, desdePipe });
    palabras = [];
    redirecciones = [];
    desdePipe = separador === "|";
    ultimoSeparador = separador;
    return undefined;
  };
  const agregar = (ch: string, protegido: boolean) => {
    w.texto += ch;
    w.enCurso = true;
    if (protegido) {
      w.citada = true;
      w.soloSinComillas = false;
    } else if (w.soloSinComillas) w.prefijo += ch;
  };
  const abrirComillas = () => {
    w.enCurso = true;
    w.citada = true;
    w.soloSinComillas = false;
  };

  const s = command;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const sig = s.charAt(i + 1);
    let error: string | undefined;
    if (ch === " " || ch === "\t") {
      error = cerrarPalabra();
    } else if (ch === "\n") {
      error = cerrarTramo("\n");
    } else if (ch === "\\") {
      if (sig === "") return { ok: false, motivo: MOTIVO.sintaxis };
      if (sig !== "\n") agregar(sig, true);
      i++;
    } else if (ch === "'") {
      const fin = s.indexOf("'", i + 1);
      if (fin < 0) return { ok: false, motivo: MOTIVO.sintaxis };
      abrirComillas();
      w.texto += s.slice(i + 1, fin);
      i = fin;
    } else if (ch === '"') {
      abrirComillas();
      let j = i + 1;
      for (; j < s.length && s.charAt(j) !== '"'; j++) {
        const c = s.charAt(j);
        const d = s.charAt(j + 1);
        if (c === "\\") {
          if (d === "\n") j++;
          else if ('"\\$`'.includes(d) && d !== "") {
            w.texto += d;
            j++;
          } else w.texto += c;
        } else if (c === "`" || (c === "$" && d === "(")) {
          return { ok: false, motivo: MOTIVO.sustitucion };
        } else if (c === "$" && d !== "" && VARIABLE.test(d)) {
          return { ok: false, motivo: MOTIVO.variable };
        } else w.texto += c;
      }
      if (j >= s.length) return { ok: false, motivo: MOTIVO.sintaxis };
      i = j;
    } else if (ch === "`" || (ch === "$" && sig === "(")) {
      return { ok: false, motivo: MOTIVO.sustitucion };
    } else if (ch === "$" && sig !== "" && VARIABLE.test(sig)) {
      return { ok: false, motivo: MOTIVO.variable };
    } else if ("(){}".includes(ch)) {
      return { ok: false, motivo: MOTIVO.llaves };
    } else if (ch === "~" && !w.enCurso) {
      return { ok: false, motivo: MOTIVO.tilde };
    } else if (ch === ";") {
      error = cerrarTramo(";");
    } else if (ch === "&" && sig === "&") {
      error = cerrarTramo("&&");
      i++;
    } else if (ch === "|" && sig === "|") {
      error = cerrarTramo("||");
      i++;
    } else if (ch === "|") {
      // `|&` también manda stderr: para la política es el mismo pipe.
      if (sig === "&") i++;
      error = cerrarTramo("|");
    } else if (ch === "&" && sig !== ">") {
      return { ok: false, motivo: MOTIVO.fondo };
    } else if (ch === "<" || ch === ">" || ch === "&") {
      // Una redirección: `N>`, `>>`, `<`, `&>`, `N>&M`, `>|`.
      let fd = "";
      if (ch === "&") {
        error = cerrarPalabra();
        fd = "&";
        i++;
      } else if (w.enCurso && !w.citada && pendiente === undefined && /^\d+$/.test(w.texto)) {
        fd = w.texto;
        limpiar();
      } else error = cerrarPalabra();
      if (error !== undefined) return { ok: false, motivo: error };
      if (pendiente !== undefined) return { ok: false, motivo: MOTIVO.sintaxis };
      const op = s.charAt(i);
      const tras = s.charAt(i + 1);
      if (tras === "(") return { ok: false, motivo: MOTIVO.sustitucion };
      let tipo: Redireccion["op"];
      if (op === "<") {
        if (tras === "<") return { ok: false, motivo: MOTIVO.heredoc };
        if (tras === ">") return { ok: false, motivo: MOTIVO.sintaxis };
        tipo = "<";
      } else if (tras === ">") {
        tipo = ">>";
        i++;
      } else {
        tipo = ">";
        if (tras === "|") i++;
      }
      let dup = false;
      if (fd !== "&" && s.charAt(i + 1) === "&") {
        dup = true;
        i++;
      }
      pendiente = { fd, op: tipo, dup };
    } else if (ch === "*" || ch === "?" || ch === "[") {
      agregar(ch, false);
      w.comodin = true;
    } else {
      agregar(ch, false);
    }
    if (error !== undefined) return { ok: false, motivo: error };
  }
  const error = cerrarTramo("fin");
  if (error !== undefined) return { ok: false, motivo: error };
  return { ok: true, tramos };
}

/** Las palabras de un comando de un solo tramo, sin las asignaciones del principio. */
function unTramo(comando: string): Palabra[] | undefined {
  const parsed = parseCommand(comando.trim());
  if (!parsed.ok || parsed.tramos.length !== 1) return undefined;
  return sinAsignaciones(parsed.tramos[0]?.palabras ?? []);
}

function sinAsignaciones(palabras: readonly Palabra[]): Palabra[] {
  const desde = palabras.findIndex((p) => p.asigna === undefined);
  return desde < 0 ? [] : palabras.slice(desde);
}

const mismaPalabra = (a: Palabra, b: Palabra) => a.texto === b.texto && a.comodin === b.comodin;
const empiezaCon = (palabras: readonly Palabra[], prefijo: readonly Palabra[]) =>
  prefijo.length > 0 &&
  prefijo.length <= palabras.length &&
  prefijo.every((p, i) => {
    const w = palabras[i];
    return w !== undefined && mismaPalabra(w, p);
  });

/** El programa de un fixer: sus palabras hasta la primera opción (`npx prettier` de `npx prettier --write`). */
function programaDe(fixer: string): Palabra[] {
  const palabras = unTramo(fixer) ?? [];
  const opcion = palabras.findIndex((p) => p.texto.startsWith("-"));
  return opcion < 0 ? palabras : palabras.slice(0, opcion);
}
const nombreDe = (palabras: readonly Palabra[]) => palabras.map((p) => p.texto).join(" ");

interface Politica {
  readonly comandos: Comandos;
  readonly exactos: readonly Palabra[][];
  readonly ampliables: readonly Palabra[][];
  readonly fixers: readonly { readonly programa: Palabra[]; readonly nombre: string }[];
}

function politicaDe(comandos: Comandos): Politica {
  const tramos = (lista: readonly string[]) =>
    lista.map(unTramo).filter((p): p is Palabra[] => p !== undefined && p.length > 0);
  return {
    comandos,
    exactos: tramos(comandos.exactos),
    ampliables: tramos(comandos.ampliables),
    fixers: comandos.fixers
      .map(programaDe)
      .filter((p) => p.length > 0)
      .map((programa) => ({ programa, nombre: nombreDe(programa) })),
  };
}

// --- Rutas -------------------------------------------------------------------------------------------

function leer(scope: Scope, palabra: Palabra, recursivo = false): Verdict {
  const verdict = recursivo
    ? checkSearchPath(scope, palabra.texto)
    : checkReadPath(scope, palabra.texto);
  if (!verdict.ok || !palabra.comodin) return verdict;
  const secreto = scope.unreadable?.find((u) => matchesGlob(u, palabra.texto));
  return secreto === undefined ? OK : no(`${secreto} tiene secretos del entorno: no se lee`);
}

function escribir(scope: Scope, palabra: Palabra): Verdict {
  if (palabra.comodin) return no(MOTIVO.comodin);
  const verdict = checkWritePath(scope, palabra.texto);
  return verdict.ok ? OK : no(MOTIVO.escribeFuera(palabra.texto, verdict.motivo));
}

function checkRedireccion(scope: Scope, r: Redireccion): Verdict {
  if (r.destino === "/dev/null" || /^&(\d+|-)$/.test(r.destino)) return OK;
  // `>&archivo` escribe en el archivo, como `>`.
  const destino = r.destino.startsWith("&") ? r.destino.slice(1) : r.destino;
  const palabra: Palabra = { texto: destino, citada: false, comodin: r.comodin };
  return r.op === "<" ? leer(scope, palabra) : escribir(scope, palabra);
}

const esNumero = (t: string) => /^[+-]?\d+$/.test(t);
const esOpcion = (t: string) => t.startsWith("-") && t !== "-";

// --- Programas ---------------------------------------------------------------------------------------

type Regla = (scope: Scope, args: readonly Palabra[], tramo: Tramo) => Verdict;

const GIT_MIRA = new Set([
  "status",
  "log",
  "diff",
  "show",
  "grep",
  "blame",
  "ls-files",
  "rev-parse",
  "shortlog",
  "describe",
  "cat-file",
]);
const GIT_ARG_PROHIBIDO = [
  "--output",
  "--ext-diff",
  "--no-index",
  "-O",
  "--open-files-in-pager",
  "--exec",
];
const GIT_BRANCH_ESCRIBE = [
  "-d",
  "-D",
  "-m",
  "-M",
  "-c",
  "-C",
  "-f",
  "-u",
  "--delete",
  "--move",
  "--copy",
  "--force",
  "--set-upstream-to",
  "--unset-upstream",
];

const git: Regla = (_scope, args) => {
  let i = 0;
  for (; i < args.length && (args[i]?.texto ?? "").startsWith("-"); i++) {
    const t = args[i]?.texto ?? "";
    if (t !== "--no-pager" && t !== "-P") return no(MOTIVO.git(t));
  }
  const sub = args[i]?.texto;
  if (sub === undefined) return OK;
  const resto = args.slice(i + 1).map((a) => a.texto);
  if (sub === "branch") {
    const escribe = resto.find(
      (t) =>
        !t.startsWith("-") ||
        GIT_BRANCH_ESCRIBE.some((o) => t === o || (o.startsWith("--") && t.startsWith(`${o}=`))),
    );
    return escribe === undefined ? OK : no(MOTIVO.git(`branch ${escribe}`));
  }
  if (sub === "remote") {
    const arg = resto.find((t) => !t.startsWith("-"));
    return arg === undefined ? OK : no(MOTIVO.git(`remote ${arg}`));
  }
  if (!GIT_MIRA.has(sub)) return no(MOTIVO.git(sub));
  const prohibido = resto.find((t) => GIT_ARG_PROHIBIDO.some((p) => t.startsWith(p)));
  return prohibido === undefined ? OK : no(MOTIVO.git(`${sub} ${prohibido}`));
};

/** Opciones de ls, cat, head… que toman el argumento siguiente. */
const TOMA_VALOR = new Set(["-n", "-c", "-L", "-I", "-d", "-f", "--lines", "--bytes"]);

const lecturaSimple =
  (programa: string): Regla =>
  (scope, args) => {
    for (let i = 0; i < args.length; i++) {
      const palabra = args[i];
      if (palabra === undefined) continue;
      const t = palabra.texto;
      if (programa === "tail" && (t === "-f" || t === "-F" || t.startsWith("--follow")))
        return no(MOTIVO.noPermitido(`tail ${t}`, scope.comandos));
      if (esOpcion(t)) {
        if (TOMA_VALOR.has(t)) i++;
        continue;
      }
      if (esNumero(t)) continue;
      const verdict = leer(scope, palabra);
      if (!verdict.ok) return verdict;
    }
    return OK;
  };

const sinArgumentos: Regla = () => OK;

const buscar =
  (programa: string): Regla =>
  (scope, args, tramo) => {
    let recursivo = programa === "rg";
    let patronAparte = false;
    const posicionales: Palabra[] = [];
    for (let i = 0; i < args.length; i++) {
      const palabra = args[i];
      if (palabra === undefined) continue;
      const t = palabra.texto;
      if (t.startsWith("--pre")) return no(MOTIVO.script(`${programa} --pre`));
      if (!esOpcion(t)) {
        posicionales.push(palabra);
        continue;
      }
      if (t === "-e" || t === "-f" || t === "--regexp" || t === "--file") {
        patronAparte = true;
        i++;
      } else if (t.startsWith("--regexp=") || t.startsWith("--file=")) patronAparte = true;
      else if (t === "--recursive" || (!t.startsWith("--") && programa !== "rg" && /[rR]/.test(t)))
        recursivo = true;
    }
    const rutas = patronAparte ? posicionales : posicionales.slice(1);
    if (recursivo && rutas.length === 0 && !tramo.desdePipe) return checkSearchPath(scope, ".");
    for (const ruta of rutas) {
      const verdict = leer(scope, ruta, recursivo);
      if (!verdict.ok) return verdict;
    }
    return OK;
  };

const FIND_PROHIBIDO = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

const find: Regla = (scope, args) => {
  if (args.some((a) => FIND_PROHIBIDO.has(a.texto))) return no(MOTIVO.archivos("find"));
  const fin = args.findIndex((a) => a.texto.startsWith("-") || a.texto === "(" || a.texto === "!");
  const rutas = fin < 0 ? args : args.slice(0, fin);
  for (const ruta of rutas.length === 0 ? [{ texto: ".", citada: false, comodin: false }] : rutas) {
    const verdict = leer(scope, ruta, true);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

/** Un script de sed que escribe o lee archivos: `w`, `W`, `r`, `R`, `e`, o el flag `w` de `s///`. */
const SED_ESCRIBE = /(^|[;{}\s])[wWeRr](\s|$)|\/[wW]\s+\S/;

const sed: Regla = (scope, args) => {
  let silencioso = false;
  const scripts: string[] = [];
  const posicionales: Palabra[] = [];
  for (let i = 0; i < args.length; i++) {
    const palabra = args[i];
    if (palabra === undefined) continue;
    const t = palabra.texto;
    if (t === "-n" || t === "--quiet" || t === "--silent") silencioso = true;
    else if (t.startsWith("-i") || t.startsWith("--in-place") || t === "-f")
      return no(MOTIVO.sedEscribe);
    else if (t === "-e" || t === "--expression") {
      const script = args[++i];
      if (script === undefined) return no(MOTIVO.sintaxis);
      scripts.push(script.texto);
    } else if (t.startsWith("--expression=")) scripts.push(t.slice("--expression=".length));
    else if (!esOpcion(t)) posicionales.push(palabra);
  }
  if (!silencioso) return no(MOTIVO.sedSinN);
  if (scripts.length === 0) {
    const script = posicionales.shift();
    if (script === undefined) return no(MOTIVO.sintaxis);
    scripts.push(script.texto);
  }
  if (scripts.some((s) => SED_ESCRIBE.test(s))) return no(MOTIVO.sedEscribe);
  for (const ruta of posicionales) {
    const verdict = leer(scope, ruta);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

const AWK_ESCRIBE = [/system\(/, /getline/, /\|/, /\bprintf?\b[^;{}]*>/];

const awk: Regla = (scope, args) => {
  let programa: string | undefined;
  const rutas: Palabra[] = [];
  for (let i = 0; i < args.length; i++) {
    const palabra = args[i];
    if (palabra === undefined) continue;
    const t = palabra.texto;
    if (programa !== undefined) {
      if (ASIGNACION.test(t)) continue;
      rutas.push(palabra);
    } else if (t === "-f") return no(MOTIVO.script("awk -f"));
    else if (t === "-v" || t === "-F") i++;
    else if (!esOpcion(t)) programa = t;
  }
  if (programa === undefined) return no(MOTIVO.sintaxis);
  const codigo = programa;
  if (AWK_ESCRIBE.some((re) => re.test(codigo))) return no(MOTIVO.script("awk"));
  for (const ruta of rutas) {
    const verdict = leer(scope, ruta);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

const sort: Regla = (scope, args) => {
  for (const palabra of args) {
    const t = palabra.texto;
    if (t.startsWith("-o") || t.startsWith("--output")) return no(MOTIVO.archivos("sort -o"));
    if (esOpcion(t) || esNumero(t)) continue;
    const verdict = leer(scope, palabra);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

const uniq: Regla = (scope, args) => {
  const archivos = args.filter((a) => !esOpcion(a.texto));
  if (archivos.length > 1) return no(MOTIVO.archivos("uniq"));
  return archivos[0] === undefined ? OK : leer(scope, archivos[0]);
};

const jq: Regla = (scope, args) => {
  const posicionales = args.filter((a) => !esOpcion(a.texto));
  for (const ruta of posicionales.slice(1)) {
    const verdict = leer(scope, ruta);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

const mkdir: Regla = (scope, args) => {
  for (const palabra of args) {
    const t = palabra.texto;
    if (esOpcion(t)) {
      if (!/^-[pv]+$/.test(t)) return no(MOTIVO.noPermitido(`mkdir ${t}`, scope.comandos));
      continue;
    }
    const verdict = escribir(scope, palabra);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

const tee: Regla = (scope, args) => {
  for (const palabra of args) {
    if (esOpcion(palabra.texto)) continue;
    const verdict = escribir(scope, palabra);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

const REGLAS: Readonly<Record<string, Regla>> = {
  git,
  ...Object.fromEntries(
    [
      "ls",
      "cat",
      "head",
      "tail",
      "wc",
      "nl",
      "file",
      "stat",
      "du",
      "tree",
      "realpath",
      "diff",
      "cmp",
      "cut",
      "column",
    ].map((p) => [p, lecturaSimple(p)]),
  ),
  ...Object.fromEntries(
    ["echo", "printf", "true", "false", "pwd", "basename", "dirname", "tr", "which"].map((p) => [
      p,
      sinArgumentos,
    ]),
  ),
  ...Object.fromEntries(["grep", "egrep", "fgrep", "rg"].map((p) => [p, buscar(p)])),
  find,
  sed,
  awk,
  sort,
  uniq,
  jq,
  mkdir,
  tee,
};

const SCRIPTS = new Set([
  "python",
  "python3",
  "node",
  "sh",
  "bash",
  "zsh",
  "eval",
  "exec",
  "source",
  ".",
  "perl",
  "ruby",
  "deno",
  "bun",
  "env",
  "xargs",
  "time",
  "timeout",
  "nohup",
]);
const RED = new Set(["curl", "wget", "ssh", "scp", "nc", "rsync", "http", "ftp"]);
const ARCHIVOS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "ln",
  "chmod",
  "chown",
  "touch",
  "dd",
  "truncate",
  "install",
]);

/** El motivo para un programa que ninguna regla permite. */
function categoria(programa: string, comandos: Comandos): string {
  if (programa.startsWith(".flowrunner/") || programa.startsWith("./.flowrunner/"))
    return MOTIVO.verify;
  if (programa === "cd") return MOTIVO.cd;
  if (SCRIPTS.has(programa) || /\.(py|sh|js|mjs)$/.test(programa)) return MOTIVO.script(programa);
  if (RED.has(programa)) return MOTIVO.red(programa);
  if (ARCHIVOS.has(programa)) return MOTIVO.archivos(programa);
  return MOTIVO.noPermitido(programa, comandos);
}

function checkFixer(
  scope: Scope,
  fixer: Politica["fixers"][number],
  args: readonly Palabra[],
): Verdict {
  const archivos: Palabra[] = [];
  for (const palabra of args) {
    const t = palabra.texto;
    if (!esOpcion(t)) {
      archivos.push(palabra);
      continue;
    }
    const opcion = t.split("=")[0] ?? t;
    if (t.startsWith("-o") || /^--(output|out-file|plugin|config)/.test(t) || t === "-c")
      return no(MOTIVO.opcionFixer(opcion, fixer.nombre));
  }
  if (archivos.length === 0) return no(MOTIVO.fixerSinArchivos(fixer.nombre));
  for (const archivo of archivos) {
    const verdict = escribir(scope, archivo);
    if (!verdict.ok) return verdict;
  }
  return OK;
}

function checkTramo(scope: Scope, politica: Politica, tramo: Tramo): Verdict {
  const primera = tramo.palabras.findIndex((p) => p.asigna === undefined);
  const asignaciones = tramo.palabras.slice(0, primera < 0 ? tramo.palabras.length : primera);
  const credencial = asignaciones.find((p) =>
    (SECRET_ENV_VARS as readonly string[]).includes(p.asigna ?? ""),
  );
  if (credencial?.asigna !== undefined) return no(MOTIVO.credencial(credencial.asigna));
  for (const r of tramo.redirecciones) {
    const verdict = checkRedireccion(scope, r);
    if (!verdict.ok) return verdict;
  }
  const palabras = tramo.palabras.slice(asignaciones.length);
  const programa = palabras[0];
  if (programa === undefined) return no(MOTIVO.sintaxis);
  if (politica.exactos.some((e) => e.length === palabras.length && empiezaCon(palabras, e)))
    return OK;
  if (politica.ampliables.some((a) => empiezaCon(palabras, a))) return OK;
  if (programa.comodin) return no(MOTIVO.noPermitido(programa.texto, scope.comandos));
  const intentos: Verdict[] = [];
  const fixer = politica.fixers.find((f) => empiezaCon(palabras, f.programa));
  if (fixer !== undefined)
    intentos.push(checkFixer(scope, fixer, palabras.slice(fixer.programa.length)));
  const regla = Object.hasOwn(REGLAS, programa.texto) ? REGLAS[programa.texto] : undefined;
  if (regla !== undefined) intentos.push(regla(scope, palabras.slice(1), tramo));
  if (intentos.some((v) => v.ok)) return OK;
  return intentos[0] ?? no(categoria(programa.texto, scope.comandos));
}

export function checkCommand(scope: Scope, command: string): Verdict {
  const trimmed = command.trim();
  const { ampliables, exactos } = scope.comandos;
  // Un criterio tal cual pasa siempre, aunque encadene pasos: es lo que ya permitía la lista exacta.
  if ([...ampliables, ...exactos].some((c) => c.trim() === trimmed)) return OK;
  const parsed = parseCommand(trimmed);
  if (!parsed.ok) return no(parsed.motivo);
  if (parsed.tramos.length === 0) return no(MOTIVO.sintaxis);
  const politica = politicaDe(scope.comandos);
  for (const tramo of parsed.tramos) {
    const verdict = checkTramo(scope, politica, tramo);
    if (!verdict.ok) return verdict;
  }
  return OK;
}

/** La política en una frase para el prompt: qué se lee, qué se corre y sobre qué se pasa el formato. */
export function describeComandos(c: Comandos): string {
  const codigo = (x: string) => `\`${x}\``;
  const partes = [
    "Podés mirar con git status, log, diff, show, grep y blame, y con ls, cat, head, tail, grep, rg, find, `sed -n`, awk y wc, encadenados con `;`, `&&` o `|`.",
  ];
  if (c.ampliables.length > 0)
    partes.push(
      `Podés correr ${c.ampliables.map(codigo).join(", ")} con lo que quieras agregar detrás, como \`-t "nombre"\` o \`2>&1 | tail -30\`.`,
    );
  const programas = [...new Set(c.fixers.map((f) => nombreDe(programaDe(f))))].filter(
    (p) => p !== "",
  );
  if (programas.length > 0)
    partes.push(
      `Podés pasar ${programas.map(codigo).join(", ")} por archivos de tu alcance y crear carpetas de tu alcance con \`mkdir -p\`.`,
    );
  partes.push(
    "No se usan `cd`, variables, `$( )`, heredocs ni scripts (`python3`, `node -e`, `sh -c`): para cambiar archivos usá Write o Edit.",
  );
  if (c.exactos.length > 0)
    partes.push(`Para instalar lo declarado: ${c.exactos.map(codigo).join(", ")}.`);
  return partes.join(" ");
}
