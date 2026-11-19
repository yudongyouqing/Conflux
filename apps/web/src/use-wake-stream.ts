import { useEffect, useRef, useState } from "react";

/**
 * Subscribe to the wake-log SSE stream for one session.
 * Returns the accumulated raw output (the woken agent's stdout) and a live
 * flag. Closes on unmount or sessionId change.
 */
export function useWakeStream(sessionId: string | null) {
  const [text, setText] = useState("");
  const [live, setLive] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setText("");
      setLive(false);
      return;
    }
    setText("");
    setLive(false);
    const es = new EventSource(`/wake/${encodeURIComponent(sessionId)}/stream`);
    esRef.current = es;
    es.addEventListener("start", () => { setText(""); setLive(false); });
    es.addEventListener("pending", () => setLive(false));
    es.addEventListener("ended", () => setLive(false));
    es.addEventListener("chunk", (ev) => {
      try {
        const chunk: unknown = JSON.parse((ev as MessageEvent).data);
        if (typeof chunk !== "string") return;
        setLive(!/\[wake ended [^\]]+\]\s*$/.test(chunk));
        setText((prev) => (prev + chunk).slice(-256 * 1024));
      } catch {
        // malformed chunk — ignore
      }
    });
    es.onerror = () => setLive(false);
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [sessionId]);

  return { text, live };
}
