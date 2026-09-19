import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cloneElement, isValidElement, type ReactNode } from "react";

/**
 * Markdown renderer for message bubbles. AI sessions answer in Markdown
 * (bold, lists, code fences); rendering it raw as pre-wrap text wastes that.
 *
 * Two tones: "light" for neutral/incoming bubbles (gray text on white),
 * "blue" for the outgoing blue bubble (white text). Element styling is
 * hand-mapped Tailwind (no typography plugin) so it stays consistent with
 * the workspace's design language.
 */

interface MarkdownTextProps {
  children: string;
  tone?: "light" | "blue";
  className?: string;
}

export function MarkdownText({ children, tone = "light", className }: MarkdownTextProps) {
  const onBlue = tone === "blue";
  // named so `pre` can cloneElement its fence child (an unlabeled fence has
  // no language-/hljs marker for Code to detect block context on its own)
  const Code = ({ className, children }: { className?: string; children?: ReactNode }) => {
    const isBlock = /language-|(^|\s)hljs(\s|$)/.test(className ?? "");
    if (isBlock) {
      // rehype-highlight decorates className with "language-x hljs" and wraps
      // the content in hljs token spans; keep those classes (token colors) but
      // let the surrounding pre own the background
      return (
        <code className={`hljs bg-transparent font-mono text-[12px] block overflow-x-auto ${className ?? ""}`}>
          {children}
        </code>
      );
    }
    return (
      <code
        className={`font-mono text-[12px] px-1 py-px rounded ${
          onBlue ? "bg-surface/25 text-white" : "bg-paper text-pink-600"
        }`}
      >
        {children}
      </code>
    );
  };
  return (
    <div
      className={`text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${className ?? ""}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          strong: ({ children }) => (
            <strong className={onBlue ? "text-white font-semibold" : "text-ink font-semibold"}>
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em className={onBlue ? "opacity-90" : "text-ink-muted"}>{children}</em>
          ),
          ul: ({ children }) => (
            <ul
              className={`list-disc pl-5 my-1.5 space-y-0.5 ${onBlue ? "marker:text-white/70" : "marker:text-ink-faint"}`}
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol
              className={`list-decimal pl-5 my-1.5 space-y-0.5 ${onBlue ? "marker:text-white/70" : "marker:text-ink-faint"}`}
            >
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-snug">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className={
                onBlue
                  ? "underline underline-offset-2"
                  : "text-accent hover:underline underline-offset-2"
              }
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote
              className={`my-1.5 pl-3 border-l-2 italic ${onBlue ? "border-accent/60" : "border-gray-300 text-ink-muted"}`}
            >
              {children}
            </blockquote>
          ),
          hr: () => <hr className={`my-2 ${onBlue ? "border-accent/50" : "border-line"}`} />,
          h1: ({ children }) => <h1 className="my-1.5 text-base font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="my-1.5 text-sm font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="my-1 text-sm font-semibold">{children}</h3>,
          code: Code,
          pre: ({ children, node }) => {
            // fenced block language from the child <code>'s className
            const child = node?.children?.[0];
            const raw: unknown =
              child && "properties" in child
                ? (child.properties as { className?: unknown })?.className
                : undefined;
            const classes: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
            const langClass = classes.find(
              (c) => typeof c === "string" && c.startsWith("language-"),
            ) as string | undefined;
            const lang = langClass ? langClass.slice("language-".length) : "code";
            // the fence child is MarkdownCode, but an unlabeled fence has no
            // language-/hljs marker for it to detect — force block styling here
            const body =
              isValidElement(children) && children.type === Code
                ? cloneElement(children, {
                    className: `hljs bg-transparent font-mono text-[12px] block overflow-x-auto ${
                      langClass ?? ""
                    }`,
                  })
                : children;
            return (
              <div className="relative my-2">
                <span
                  className={`absolute top-1.5 right-2 text-[10px] font-mono uppercase tracking-wide select-none pointer-events-none ${
                    onBlue ? "text-blue-300/60" : "text-ink-muted"
                  }`}
                >
                  {lang}
                </span>
                <pre
                  className={`p-2.5 rounded-lg overflow-x-auto text-[12px] leading-snug ${
                    onBlue ? "bg-black/20 border border-accent/30" : "bg-gray-900 text-gray-100"
                  }`}
                >
                  {body}
                </pre>
              </div>
            );
          },
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className={`text-[12px] border-collapse ${onBlue ? "" : "text-ink"}`}>
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th
              className={`border px-2 py-1 text-left font-semibold ${
                onBlue ? "border-accent/50" : "border-gray-300 bg-paper"
              }`}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className={`border px-2 py-1 ${onBlue ? "border-accent/50" : "border-line"}`}>
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
