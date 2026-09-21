import type { ReactNode } from "react";

/**
 * Inline-only markdown for one-line previews (session list descriptions,
 * message card summaries) — the Slack/Discord style: bold, italic,
 * strikethrough, inline code and links render; everything block-level
 * (headers, lists, fences) stays literal text. Unclosed markers stay
 * literal too, so partial streaming text never looks broken.
 * Truncation remains the parent's `truncate` job — this only styles spans.
 */

type Kind = "text" | "code" | "bold" | "italic" | "strike" | "link";

interface Seg {
  kind: Kind;
  value: string;
  href?: string;
}

const TOKEN_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function tokenize(text: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > last) segs.push({ kind: "text", value: text.slice(last, start) });
    const raw = m[0];
    if (raw.startsWith("`")) segs.push({ kind: "code", value: raw.slice(1, -1) });
    else if (raw.startsWith("**")) segs.push({ kind: "bold", value: raw.slice(2, -2) });
    else if (raw.startsWith("__")) segs.push({ kind: "bold", value: raw.slice(2, -2) });
    else if (raw.startsWith("~~")) segs.push({ kind: "strike", value: raw.slice(2, -2) });
    else if (raw.startsWith("[")) {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(raw);
      if (link) segs.push({ kind: "link", value: link[1], href: link[2] });
      else segs.push({ kind: "text", value: raw });
    } else segs.push({ kind: "italic", value: raw.slice(1, -1) });
    last = start + raw.length;
  }
  if (last < text.length) segs.push({ kind: "text", value: text.slice(last) });
  return segs;
}

function render(seg: Seg, i: number): ReactNode {
  switch (seg.kind) {
    case "code":
      return (
        <code key={i} className="font-mono text-[11px] px-1 py-px rounded bg-paper text-pink-600">
          {seg.value}
        </code>
      );
    case "bold":
      return (
        <strong key={i} className="font-semibold text-ink">
          {seg.value}
        </strong>
      );
    case "italic":
      return (
        <em key={i} className="text-ink-muted">
          {seg.value}
        </em>
      );
    case "strike":
      return (
        <span key={i} className="line-through text-ink-faint">
          {seg.value}
        </span>
      );
    case "link":
      return (
        <a
          key={i}
          href={seg.href}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline underline-offset-2"
        >
          {seg.value}
        </a>
      );
    default:
      return <span key={i}>{seg.value}</span>;
  }
}

export function InlineMarkdown({ children, className }: { children: string; className?: string }) {
  return <span className={className}>{tokenize(children).map(render)}</span>;
}
