// El transcript de una sesión como pasos de texto: lo que dijo el modelo, cada herramienta con su
// entrada, su resultado y lo que se le negó.
import { plain } from "./report.ts";

export interface Step {
  readonly tipo: "texto" | "herramienta" | "resultado" | "final";
  readonly texto: string;
}

const MAX = 2_000;
const cut = (text: string) =>
  text.length > MAX ? `${text.slice(0, MAX)}… (${text.length - MAX} caracteres más)` : text;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "object" && c !== null && "text" in c
          ? String((c as { text: unknown }).text)
          : "",
      )
      .join("\n");
  }
  return JSON.stringify(content);
}

export function transcriptSteps(jsonl: string): Step[] {
  const steps: Step[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let m: {
      type?: string;
      message?: { content?: unknown };
      result?: unknown;
      subtype?: string;
      total_cost_usd?: number;
    };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      continue;
    }
    const blocks = Array.isArray(m.message?.content)
      ? (m.message.content as Record<string, unknown>[])
      : [];
    if (m.type === "assistant") {
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "")
          steps.push({ tipo: "texto", texto: plain(cut(b.text)) });
        if (b.type === "tool_use")
          steps.push({
            tipo: "herramienta",
            texto: plain(cut(`${String(b.name)} ${JSON.stringify(b.input)}`)),
          });
      }
    } else if (m.type === "user") {
      for (const b of blocks) {
        if (b.type === "tool_result")
          steps.push({ tipo: "resultado", texto: plain(cut(contentText(b.content))) });
      }
    } else if (m.type === "result") {
      steps.push({
        tipo: "final",
        texto: `${m.subtype ?? ""} · USD ${(m.total_cost_usd ?? 0).toFixed(4)}`,
      });
    }
  }
  return steps;
}

export function describeSteps(steps: readonly Step[]): string {
  const mark = { texto: "·", herramienta: "▸", resultado: "  ←", final: "■" } as const;
  return steps.map((s) => `${mark[s.tipo]} ${s.texto}`).join("\n");
}
