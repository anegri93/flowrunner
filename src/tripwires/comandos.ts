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
  insideRoot,
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
  asignacion:
    "las variables de entorno (`NOMBRE=valor`) solo van delante de los comandos de tus criterios o de instalar",
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
        } else if (c === "`" || (c === "$" && (d === "(" || d === "["))) {
          return { ok: false, motivo: MOTIVO.sustitucion };
        } else if (c === "$" && d !== "" && VARIABLE.test(d)) {
          return { ok: false, motivo: MOTIVO.variable };
        } else w.texto += c;
      }
      if (j >= s.length) return { ok: false, motivo: MOTIVO.sintaxis };
      i = j;
    } else if (ch === "`" || (ch === "$" && (sig === "(" || sig === "["))) {
      // `$[…]` es la aritmética vieja de bash: también se reemplaza por su resultado.
      return { ok: false, motivo: MOTIVO.sustitucion };
    } else if (ch === "$" && sig !== "" && VARIABLE.test(sig)) {
      return { ok: false, motivo: MOTIVO.variable };
    } else if (ch === "$" && (sig === "'" || sig === '"')) {
      // `$'…'` y `$"…"` son comillas de bash con escapes propios: `$'\x2e'` es un punto.
      return { ok: false, motivo: MOTIVO.sintaxis };
    } else if (ch === "#" && !w.enCurso) {
      // Un comentario, hasta el fin de la línea: sh no lee comillas ni operadores ahí.
      const nl = s.indexOf("\n", i);
      i = (nl < 0 ? s.length : nl) - 1;
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

/**
 * Un segmento con comodín que el shell puede expandir a `.` o `..`, como `.*` o `.?`: `cat .*` + `/x`
 * lee `../x`. Un segmento que empieza con `*` o `?` no abarca nombres con punto adelante.
 */
function subeConComodin(ruta: string): boolean {
  return ruta.split("/").some((segmento) => {
    if (!/[*?[]/.test(segmento)) return false;
    if (segmento.startsWith("[")) return true;
    if (!segmento.startsWith(".")) return false;
    try {
      const re = new RegExp(
        `^${segmento
          .replace(/[.+^${}()|\\]/g, "\\$&")
          .replaceAll("*", ".*")
          .replaceAll("?", ".")
          .replaceAll("[!", "[^")}$`,
      );
      return re.test(".") || re.test("..");
    } catch {
      return true;
    }
  });
}

/** `config` de `config/.env`: las carpetas que, buscadas, abarcan el archivo. */
const carpetasDe = (rel: string) => {
  const partes = rel.split("/");
  return partes.slice(1).map((_, i) => partes.slice(0, i + 1).join("/"));
};

function leer(scope: Scope, palabra: Palabra, recursivo = false): Verdict {
  const verdict = recursivo
    ? checkSearchPath(scope, palabra.texto)
    : checkReadPath(scope, palabra.texto);
  if (!verdict.ok || !palabra.comodin) return verdict;
  if (subeConComodin(palabra.texto)) return no(`${palabra.texto} queda fuera del worktree`);
  // El comodín, como lo ve el shell desde la raíz: `./.env*` y `src/../.env*` son `.env*`.
  const rel = insideRoot(scope, palabra.texto) ?? palabra.texto;
  const patrones = [palabra.texto, rel];
  for (const secreto of scope.unreadable ?? []) {
    if (patrones.some((p) => matchesGlob(secreto, p)))
      return no(`${secreto} tiene secretos del entorno: no se lee`);
    if (recursivo && carpetasDe(secreto).some((c) => patrones.some((p) => matchesGlob(c, p))))
      return no(
        `buscar en ${rel} incluye ${secreto}, que tiene secretos del entorno: buscá dentro de una carpeta que no lo tenga, como src/`,
      );
  }
  return OK;
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

/** El nombre de una opción larga, sin `=valor`. */
const nombreLargo = (t: string) => {
  const igual = t.indexOf("=");
  return igual < 0 ? t : t.slice(0, igual);
};
/**
 * Si `t` es la opción larga `opcion`, entera o abreviada: getopt_long, git y el sort de macOS aceptan
 * cualquier prefijo, hasta de una letra (`--o`, `--recur`, `--no-ind`). Un prefijo ambiguo también
 * cuenta: da un rechazo de más, no uno de menos.
 */
const esLarga = (t: string, opcion: string) => {
  const nombre = nombreLargo(t);
  return (
    t.startsWith("--") && (nombre === opcion || (nombre.length >= 3 && opcion.startsWith(nombre)))
  );
};
/** Las letras de un grupo de opciones cortas (`-lO…` da `lO…`), o "" si no es uno. */
const cortas = (t: string) => (esOpcion(t) && !t.startsWith("--") ? t.slice(1) : "");

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
/** Las opciones largas de git que escriben, ejecutan o leen fuera de lo versionado. */
const GIT_LARGAS_PROHIBIDAS = [
  "--output",
  "--ext-diff",
  "--no-index",
  "--open-files-in-pager",
  "--exec",
  // Lee un archivo cualquiera, versionado o no, como si fuera el contenido del blame.
  "--contents",
];
/** `git grep` que busca también en lo que no está versionado, como los .env que copia flowrunner. */
const GIT_GREP_SIN_VERSIONAR = ["--untracked", "--no-exclude-standard"];
/**
 * Opciones que leen un archivo del worktree: git imprime en el error las líneas que no entiende, y
 * así mostraba el .env. Sin comprobar la ruta: no se usan.
 */
const GIT_LEEN_ARCHIVO = ["--pathspec-from-file", "--ignore-revs-file", "--exclude-from", "--file"];
const GIT_CORTAS_LEEN_ARCHIVO: Readonly<Record<string, RegExp>> = {
  grep: /f/,
  blame: /S/,
  "ls-files": /X/,
};
const GIT_BRANCH_LARGAS = [
  "--delete",
  "--move",
  "--copy",
  "--force",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
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
        /[dDmMcCfu]/.test(cortas(t)) ||
        GIT_BRANCH_LARGAS.some((o) => esLarga(t, o)),
    );
    return escribe === undefined ? OK : no(MOTIVO.git(`branch ${escribe}`));
  }
  if (sub === "remote") {
    const arg = resto.find((t) => !t.startsWith("-"));
    return arg === undefined ? OK : no(MOTIVO.git(`remote ${arg}`));
  }
  if (!GIT_MIRA.has(sub)) return no(MOTIVO.git(sub));
  // `-O` también dentro de un grupo (`-lO<pager>`): `git grep` corre el pager con el shell.
  const prohibido = resto.find(
    (t) =>
      cortas(t).includes("O") ||
      GIT_LARGAS_PROHIBIDAS.some((o) => esLarga(t, o)) ||
      (sub === "grep" && GIT_GREP_SIN_VERSIONAR.some((o) => esLarga(t, o))) ||
      GIT_LEEN_ARCHIVO.some((o) => esLarga(t, o)) ||
      GIT_CORTAS_LEEN_ARCHIVO[sub]?.test(cortas(t)) === true,
  );
  return prohibido === undefined ? OK : no(MOTIVO.git(`${sub} ${prohibido}`));
};

/**
 * Las letras de ls, cat, head… que toman un valor: en un grupo, la primera se lleva lo que sigue
 * pegado (`-n5`, `-bf.env`), y eso también es una ruta. El valor que va separado se comprueba como
 * cualquier argumento: para `cat`, `-n` no toma nada, y saltear lo que seguía dejaba pasar
 * `cat -n .env.local`.
 */
const TOMA_VALOR = "ncLIdf";
/**
 * Los programas con otras letras de valor. `file -m` y `-f` leen un archivo. Las de `cut` son
 * listas y delimitadores, nunca archivos, y siempre toman valor: `cut -d / -f2` no lee `/`.
 */
const VALOR_DE: Readonly<Record<string, { letras: string; rutas: boolean }>> = {
  file: { letras: "mfFeP", rutas: true },
  cut: { letras: "bcdf", rutas: false },
};

/** Opciones que hacen que un programa de lectura escriba, ejecute o no termine. */
const LECTURA_PROHIBIDA: Readonly<Record<string, { cortas: string; largas: readonly string[] }>> = {
  tail: { cortas: "fF", largas: ["--follow"] },
  tree: { cortas: "o", largas: [] },
  file: { cortas: "C", largas: ["--compile"] },
};

const lecturaSimple =
  (programa: string): Regla =>
  (scope, args) => {
    // diff recorre una carpeta aunque no lleve -r: `diff -N . src` imprime todo lo que hay en `.`.
    const recursivo = programa === "diff";
    const prohibida = LECTURA_PROHIBIDA[programa];
    const { letras: conValor, rutas: valorEsRuta } = VALOR_DE[programa] ?? {
      letras: TOMA_VALOR,
      rutas: true,
    };
    const rutas: Palabra[] = [];
    let opciones = true;
    for (let i = 0; i < args.length; i++) {
      const palabra = args[i];
      if (palabra === undefined) continue;
      const t = palabra.texto;
      if (!opciones || !esOpcion(t)) {
        if (!esNumero(t)) rutas.push(palabra);
        continue;
      }
      if (t === "--") {
        opciones = false;
        continue;
      }
      let valor = "";
      if (t.startsWith("--")) {
        if (prohibida?.largas.some((o) => esLarga(t, o)) === true)
          return no(MOTIVO.noPermitido(`${programa} ${t}`, scope.comandos));
        // El valor de `--from-file=x` también es una ruta.
        valor = t.slice(nombreLargo(t).length + 1);
      } else {
        const letras = cortas(t);
        for (let k = 0; k < letras.length; k++) {
          const letra = letras.charAt(k);
          if (prohibida?.cortas.includes(letra) === true)
            return no(MOTIVO.noPermitido(`${programa} ${t}`, scope.comandos));
          if (conValor.includes(letra)) {
            valor = letras.slice(k + 1);
            // Un valor que no es ruta se lleva la palabra siguiente si no va pegado.
            if (!valorEsRuta && valor === "") i++;
            break;
          }
        }
      }
      if (valorEsRuta && valor !== "" && !esNumero(valor)) rutas.push({ ...palabra, texto: valor });
    }
    for (const ruta of rutas) {
      const verdict = leer(scope, ruta, recursivo);
      if (!verdict.ok) return verdict;
    }
    return OK;
  };

const sinArgumentos: Regla = () => OK;

/** Las opciones cortas de grep y rg que toman un valor: `-A 3`, `-e patrón`, `-f archivo`. */
const VALOR_CORTO = { grep: "ABCDdefm", rg: "ABCEMTdefgjmrt" } as const;
/** Las largas, cuando el valor va separado: `--max-count 1`. */
const VALOR_LARGO = new Set([
  "--after-context",
  "--before-context",
  "--binary-files",
  "--colors",
  "--context",
  "--context-separator",
  "--devices",
  "--dfa-size-limit",
  "--directories",
  "--encoding",
  "--engine",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--field-context-separator",
  "--field-match-separator",
  "--file",
  "--glob",
  "--group-separator",
  "--hyperlink-format",
  "--iglob",
  "--ignore-file",
  "--include",
  "--include-dir",
  "--label",
  "--max-columns",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--path-separator",
  "--regex-size-limit",
  "--regexp",
  "--replace",
  "--sort",
  "--sortr",
  "--threads",
  "--type",
  "--type-add",
  "--type-clear",
  "--type-not",
]);
/** Opciones cuyo valor es un archivo que se lee. */
const VALOR_ES_ARCHIVO = new Set(["-f", "--file", "--exclude-from", "--ignore-file"]);

const buscar =
  (programa: string): Regla =>
  (scope, args, tramo) => {
    const esRg = programa === "rg";
    const conValor = esRg ? VALOR_CORTO.rg : VALOR_CORTO.grep;
    // En un objeto: `opcion` los cambia, y TypeScript no sigue ese cambio en variables sueltas.
    const visto = { recursivo: esRg, patronAparte: false };
    /**
     * Las palabras que no son opciones. Una que sigue a una opción larga sin `=` puede ser su valor
     * o no (`--context` de BSD tiene el valor opcional): se comprueba como ruta igual, y no cuenta
     * para decidir si hay rutas (`dudosas`).
     */
    const posicionales: Palabra[] = [];
    let dudosas = 0;
    const archivos: Palabra[] = [];
    /** Lo que hace una opción con su valor. */
    const opcion = (nombre: string, valor: Palabra | undefined) => {
      if (["-e", "--regexp", "-f", "--file"].some((o) => nombre === o || esLarga(nombre, o)))
        visto.patronAparte = true;
      const directorios = nombre === "-d" || esLarga(nombre, "--directories");
      // grep de BSD lee el valor sin mayúsculas y abreviado: `-d RECURSE`, `-d rec`.
      const recurse = valor !== undefined && valor.texto !== "";
      if (!esRg && directorios && recurse && "recurse".startsWith(valor.texto.toLowerCase()))
        visto.recursivo = true;
      if ([...VALOR_ES_ARCHIVO].some((o) => nombre === o || esLarga(nombre, o)) && valor)
        archivos.push(valor);
    };
    let opciones = true;
    for (let i = 0; i < args.length; i++) {
      const palabra = args[i];
      if (palabra === undefined) continue;
      const t = palabra.texto;
      if (!opciones || !esOpcion(t)) {
        posicionales.push(palabra);
        continue;
      }
      if (t === "--") {
        opciones = false;
        continue;
      }
      if (t.startsWith("--pre") || t.startsWith("--hostname-bin"))
        return no(MOTIVO.script(`${programa} ${nombreLargo(t)}`));
      if (t.startsWith("--")) {
        if (esLarga(t, "--recursive") || esLarga(t, "--dereference-recursive"))
          visto.recursivo = true;
        const nombre = nombreLargo(t);
        if (nombre !== t) opcion(nombre, { ...palabra, texto: t.slice(nombre.length + 1) });
        else if ([...VALOR_LARGO].some((o) => esLarga(t, o))) {
          const siguiente = args[i + 1];
          if (siguiente !== undefined && !esOpcion(siguiente.texto)) {
            opcion(nombre, siguiente);
            posicionales.push(siguiente);
            dudosas++;
            i++;
          }
        }
        continue;
      }
      // Un grupo de opciones cortas, como `-rnA3`: la primera que toma valor se lleva el resto.
      for (let k = 1; k < t.length; k++) {
        const letra = t.charAt(k);
        if (!esRg && (letra === "r" || letra === "R")) visto.recursivo = true;
        if (!conValor.includes(letra)) continue;
        const pegado = t.slice(k + 1);
        opcion(`-${letra}`, pegado === "" ? args[++i] : { ...palabra, texto: pegado });
        break;
      }
    }
    for (const archivo of archivos) {
      const verdict = leer(scope, archivo);
      if (!verdict.ok) return verdict;
    }
    // La primera palabra nunca es un archivo: es el patrón, o el valor de una opción.
    const rutas = visto.patronAparte ? posicionales : posicionales.slice(1);
    const seguras = posicionales.length - dudosas - (visto.patronAparte ? 0 : 1);
    // Sin rutas, grep -r busca en `.` aunque le llegue un pipe (el de BSD y el de GNU); rg lee el pipe.
    if (visto.recursivo && seguras <= 0 && !(esRg && tramo.desdePipe)) {
      const raiz = checkSearchPath(scope, ".");
      if (!raiz.ok) return raiz;
    }
    for (const ruta of rutas) {
      const verdict = leer(scope, ruta, visto.recursivo);
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

/** Los comandos de sed que solo miran; `l`, `q` y `Q` pueden llevar un número. */
const SED_MIRA = "pPlqQdDnNgGhHxz=F";

/**
 * Si un script de sed puede escribir, leer otro archivo o ejecutar algo. Lee sus comandos uno por uno,
 * porque `SED_ESCRIBE` no ve `1w x`, `$w x`, `1r x` ni `s/a/b/e`. Ante lo que no entiende, sí.
 */
function sedPeligroso(script: string): boolean {
  let i = 0;
  const c = (k = i) => script.charAt(k);
  const blancos = () => {
    while (c() === " " || c() === "\t") i++;
  };
  const digitos = () => {
    while (/\d/.test(c())) i++;
  };
  /** Avanza hasta pasar el delimitador que cierra; falso si no cierra en la línea. */
  const hasta = (delim: string): boolean => {
    while (i < script.length) {
      const x = c();
      if (x === "\\") i += 2;
      else if (x === "\n") return false;
      else {
        i++;
        if (x === delim) return true;
      }
    }
    return false;
  };
  const delimitadorValido = (d: string) => d !== "" && d !== "\n" && d !== "\\";
  const direccion = (): boolean => {
    const x = c();
    if (/\d/.test(x)) {
      digitos();
      if (c() === "~") {
        i++;
        digitos();
      }
    } else if (x === "$") i++;
    else if (x === "/" || x === "\\") {
      const delim = x === "/" ? "/" : c(i + 1);
      i += x === "/" ? 1 : 2;
      if (!delimitadorValido(delim) || !hasta(delim)) return false;
      while (c() === "I" || c() === "M") i++;
    }
    return true;
  };
  const finDeComando = () => {
    blancos();
    return ["", ";", "\n", "}", "#"].includes(c());
  };
  const hastaFinDeLinea = () => {
    const nl = script.indexOf("\n", i);
    const linea = script.slice(i, nl < 0 ? script.length : nl);
    i = nl < 0 ? script.length : nl + 1;
    return linea;
  };
  for (;;) {
    while (i < script.length && /[\s;]/.test(c())) i++;
    if (i >= script.length) return false;
    if (!direccion()) return true;
    blancos();
    if (c() === ",") {
      i++;
      blancos();
      if (c() === "+" || c() === "~") i++;
      if (!direccion()) return true;
      blancos();
    }
    while (c() === "!") {
      i++;
      blancos();
    }
    const cmd = c();
    i++;
    if (cmd === "{" || cmd === "}") continue;
    if (cmd === "#") hastaFinDeLinea();
    else if (cmd !== "" && SED_MIRA.includes(cmd)) {
      blancos();
      digitos();
      if (!finDeComando()) return true;
    } else if (cmd === ":" || cmd === "b" || cmd === "t" || cmd === "T") {
      // La etiqueta, hasta `;` o el fin de línea: si sed la lee más larga, se miró de más.
      while (i < script.length && c() !== ";" && c() !== "\n") i++;
    } else if (cmd === "a" || cmd === "i" || cmd === "c") {
      // El texto, hasta una línea que no termina en `\`.
      // Una línea con `\\` al final termina: la barra está escapada.
      while (i < script.length && /(^|[^\\])(\\\\)*\\$/.test(hastaFinDeLinea()));
    } else if (cmd === "s" || cmd === "y") {
      const delim = c();
      i++;
      if (!delimitadorValido(delim) || !hasta(delim) || !hasta(delim)) return true;
      if (cmd === "s") while (/[gpiImM0-9]/.test(c())) i++;
      if (!finDeComando()) return true;
    } else return true;
  }
}

/** Las opciones cortas de sed que solo cambian cómo lee: `-n`, `-E`, `-r`, `-s`, `-u`, `-z`. */
const SED_CORTAS = "nErsuz";
const SED_LARGAS = new Set([
  "--quiet",
  "--silent",
  "--regexp-extended",
  "--separate",
  "--unbuffered",
  "--null-data",
  "--posix",
  "--debug",
  "--sandbox",
]);

const sed: Regla = (scope, args) => {
  let silencioso = false;
  const scripts: string[] = [];
  const posicionales: Palabra[] = [];
  let opciones = true;
  for (let i = 0; i < args.length; i++) {
    const palabra = args[i];
    if (palabra === undefined) continue;
    const t = palabra.texto;
    if (!opciones || !esOpcion(t)) {
      posicionales.push(palabra);
    } else if (t === "--") {
      opciones = false;
    } else if (t.startsWith("--")) {
      const igual = t.indexOf("=");
      const nombre = igual < 0 ? t : t.slice(0, igual);
      if (nombre === "--quiet" || nombre === "--silent") silencioso = true;
      if (nombre === "--expression") {
        const script = igual < 0 ? args[++i]?.texto : t.slice(igual + 1);
        if (script === undefined) return no(MOTIVO.sintaxis);
        scripts.push(script);
      } else if (!SED_LARGAS.has(nombre) || igual >= 0) return no(MOTIVO.sedEscribe);
    } else {
      // Un grupo como `-nE` o `-ne p`. `-i`, `-I` (el de BSD) y `-f` no; nada desconocido, tampoco.
      for (let k = 1; k < t.length; k++) {
        const letra = t.charAt(k);
        if (letra === "n") silencioso = true;
        if (letra === "e") {
          const script = k + 1 < t.length ? t.slice(k + 1) : args[++i]?.texto;
          if (script === undefined) return no(MOTIVO.sintaxis);
          scripts.push(script);
          break;
        }
        if (!SED_CORTAS.includes(letra)) return no(MOTIVO.sedEscribe);
      }
    }
  }
  if (!silencioso) return no(MOTIVO.sedSinN);
  if (scripts.length === 0) {
    const script = posicionales.shift();
    if (script === undefined) return no(MOTIVO.sintaxis);
    scripts.push(script.texto);
  }
  if (scripts.some((s) => SED_ESCRIBE.test(s) || sedPeligroso(s))) return no(MOTIVO.sedEscribe);
  for (const ruta of posicionales) {
    const verdict = leer(scope, ruta);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

const AWK_ESCRIBE = [
  /system\(/,
  /getline/,
  /\|/,
  /\bprintf?\b[^;{}]*>/,
  // `system ("x")` también llama; `@load` y `@include` de gawk cargan código; ARGV cambia qué lee.
  /\bsystem\s*\(/,
  /@/,
  /\bARGV\b/,
];

const awk: Regla = (scope, args) => {
  let programa: string | undefined;
  const rutas: Palabra[] = [];
  for (let i = 0; i < args.length; i++) {
    const palabra = args[i];
    if (palabra === undefined) continue;
    const t = palabra.texto;
    if (programa !== undefined) {
      if (ASIGNACION.test(t) || (t === "--" && rutas.length === 0)) continue;
      rutas.push(palabra);
    } else if (t === "-v" || t === "-F") i++;
    else if (!esOpcion(t)) programa = t;
    // Solo `-v` y `-F`: `-f` lee el programa de un archivo, y gawk carga código con `-l`, `-i` y `-E`.
    else if (!/^-[vF]./.test(t) && t !== "--") return no(MOTIVO.script(`awk ${t}`));
  }
  if (programa === undefined) return no(MOTIVO.sintaxis);
  const codigo = programa;
  // Las reglas se miran también sin las cadenas: un `}` o un `;` entre comillas cortaba la de `print >`.
  const sinCadenas = codigo.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (AWK_ESCRIBE.some((re) => re.test(codigo) || re.test(sinCadenas)))
    return no(MOTIVO.script("awk"));
  // Fuera de las cadenas, un `>` es una redirección, salvo `>=` o una comparación con un número.
  // Sobre el código tal cual también: una `"` dentro de `/…/` desalinea las cadenas de `sinCadenas`.
  if ([sinCadenas, codigo].some((c) => />(?!=)(?!\s*\d)/.test(c))) return no(MOTIVO.script("awk"));
  for (const ruta of rutas) {
    const verdict = leer(scope, ruta);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

const sort: Regla = (scope, args) => {
  const rutas: Palabra[] = [];
  let opciones = true;
  for (let i = 0; i < args.length; i++) {
    const palabra = args[i];
    if (palabra === undefined) continue;
    const t = palabra.texto;
    if (!opciones || !esOpcion(t)) {
      if (!esNumero(t)) rutas.push(palabra);
      continue;
    }
    if (t === "--") {
      opciones = false;
      continue;
    }
    if (t.startsWith("--")) {
      if (esLarga(t, "--output") || esLarga(t, "--temporary-directory"))
        return no(MOTIVO.archivos(`sort ${nombreLargo(t)}`));
      if (esLarga(t, "--compress-program")) return no(MOTIVO.script(`sort ${nombreLargo(t)}`));
      // `--files0-from=x` y `--random-source=x` leen x.
      const valor = t.slice(nombreLargo(t).length + 1);
      if (valor !== "") rutas.push({ ...palabra, texto: valor });
      continue;
    }
    // Un grupo como `-nk2` o `-t:`: `-o` y `-T` escriben archivos; `-k`, `-t` y `-S` toman valor.
    for (let k = 1; k < t.length; k++) {
      const letra = t.charAt(k);
      if (letra === "o" || letra === "T") return no(MOTIVO.archivos(`sort -${letra}`));
      if ("ktS".includes(letra)) {
        if (k === t.length - 1) i++;
        break;
      }
    }
  }
  for (const ruta of rutas) {
    const verdict = leer(scope, ruta);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

/** Las palabras que no son opciones, con todo lo que sigue a `--`. */
function operandos(args: readonly Palabra[]): Palabra[] {
  const fin = args.findIndex((a) => a.texto === "--");
  const antes = fin < 0 ? args : args.slice(0, fin);
  return [...antes.filter((a) => !esOpcion(a.texto)), ...(fin < 0 ? [] : args.slice(fin + 1))];
}
/** Las opciones: lo que empieza con `-` antes de `--`. */
function opcionesDe(args: readonly Palabra[]): Palabra[] {
  const fin = args.findIndex((a) => a.texto === "--");
  return (fin < 0 ? args : args.slice(0, fin)).filter((a) => esOpcion(a.texto));
}

const uniq: Regla = (scope, args) => {
  const archivos = operandos(args);
  if (archivos.length > 1) return no(MOTIVO.archivos("uniq"));
  return archivos[0] === undefined ? OK : leer(scope, archivos[0]);
};

const jq: Regla = (scope, args) => {
  // `-f` lee el filtro de un archivo, y jq muestra pedazos de un filtro que no compila.
  const desdeArchivo = opcionesDe(args).find(
    (a) => esLarga(a.texto, "--from-file") || cortas(a.texto).includes("f"),
  );
  if (desdeArchivo !== undefined) return no(MOTIVO.script(`jq ${desdeArchivo.texto}`));
  for (const ruta of operandos(args).slice(1)) {
    const verdict = leer(scope, ruta);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

const mkdir: Regla = (scope, args) => {
  const mala = opcionesDe(args).find((a) => !/^-[pv]+$/.test(a.texto));
  if (mala !== undefined) return no(MOTIVO.noPermitido(`mkdir ${mala.texto}`, scope.comandos));
  for (const carpeta of operandos(args)) {
    const verdict = escribir(scope, carpeta);
    if (!verdict.ok) return verdict;
  }
  return OK;
};

const tee: Regla = (scope, args) => {
  for (const archivo of operandos(args)) {
    const verdict = escribir(scope, archivo);
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

/**
 * Una ruta que un fixer puede expandir por su cuenta: prettier y eslint leen sus argumentos como
 * globs, con llaves y comodines aunque vayan citados (`'src/a/{x.ts,../../CLAUDE.md}'`). Los corchetes
 * de Next (`[id]`) quedan: no cruzan una `/`, y la ruta literal ya pasa por el alcance.
 */
const fixerExpande = (ruta: string) => /[{}*?]/.test(ruta) || ruta.split("/").includes("..");

function checkFixer(
  scope: Scope,
  fixer: Politica["fixers"][number],
  args: readonly Palabra[],
): Verdict {
  for (const palabra of opcionesDe(args)) {
    const t = palabra.texto;
    if (t.startsWith("-o") || /^--(output|out-file|plugin|config)/.test(t) || t === "-c")
      return no(MOTIVO.opcionFixer(nombreLargo(t), fixer.nombre));
  }
  // El valor de `--cache-location=x` y parecidos, si parece una ruta, se escribe.
  const valores = opcionesDe(args)
    .filter((a) => a.texto.startsWith("--") && a.texto.includes("="))
    .map((a) => ({ ...a, texto: a.texto.slice(nombreLargo(a.texto).length + 1) }))
    .filter((v) => /[/.]/.test(v.texto) && !esNumero(v.texto));
  const archivos = operandos(args);
  if (archivos.length === 0) return no(MOTIVO.fixerSinArchivos(fixer.nombre));
  for (const archivo of [...archivos, ...valores]) {
    if (fixerExpande(archivo.texto)) return no(MOTIVO.comodin);
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
  if (programa === undefined)
    return no(asignaciones.length > 0 ? MOTIVO.asignacion : MOTIVO.sintaxis);
  if (politica.exactos.some((e) => e.length === palabras.length && empiezaCon(palabras, e)))
    return OK;
  if (politica.ampliables.some((a) => empiezaCon(palabras, a))) return OK;
  // Una variable cambia qué corre un programa de lectura: GIT_EXTERNAL_DIFF, GIT_CONFIG_* o PATH.
  // Delante de un criterio no abre nada nuevo: el criterio ya corre el código de la sub-task.
  if (asignaciones.length > 0) return no(MOTIVO.asignacion);
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
