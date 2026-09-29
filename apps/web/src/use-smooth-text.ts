import { useEffect, useRef, useState } from "react";

/**
 * Typewriter pacing for streaming text (#111, PI-Desktop pattern):
 * chunks land in state as fast as the network delivers them; this hook paces
 * what the user sees — base 60 cps, speeding up when backlog grows so the
 * lag never exceeds ~500ms, and slicing on code-point boundaries so CJK /
 * emoji never break. Flushes instantly on stream end and unmount.
 * prefers-reduced-motion: returns the target verbatim.
 */
export function useSmoothText(target: string, opts: { active?: boolean } = {}): string {
  const active = opts.active ?? true;
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    setReduced(mq?.matches ?? false);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  const [shown, setShown] = useState(active ? "" : target);
  const ref = useRef({ pos: 0, raf: 0, lastTs: 0 });

  useEffect(() => {
    if (!active || reduced) {
      ref.current.pos = target.length;
      setShown(target);
      return;
    }
    // target replaced wholesale (new message): restart from 0
    if (!target.startsWith(shown)) {
      ref.current.pos = 0;
      setShown("");
    }
    const state = ref.current;
    if (state.pos >= target.length) return; // nothing new yet

    const tick = (ts: number) => {
      const dt = state.lastTs ? Math.min((ts - state.lastTs) / 1000, 0.25) : 0.016;
      state.lastTs = ts;
      const backlog = target.length - state.pos;
      const cps = backlog > 30 ? Math.max(60, backlog / 0.5) : 60;
      let next = state.pos + Math.max(1, Math.round(cps * dt));
      // never race past the arriving target
      if (next > target.length) next = target.length;
      // code-point safety: don't stop between a surrogate pair
      while (next < target.length && next > state.pos) {
        const code = target.charCodeAt(next - 1);
        if (code >= 0xd800 && code <= 0xdbff) next -= 1;
        else break;
      }
      state.pos = next;
      setShown(target.slice(0, next));
      if (next < target.length) state.raf = requestAnimationFrame(tick);
    };
    state.lastTs = 0;
    state.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(state.raf);
    // shown deliberately excluded: pacing reads target/ref only
  }, [target, active, reduced]);

  // flush on unmount is implicit (component gone); flush when inactive too
  useEffect(() => {
    if (!active && shown !== target) setShown(target);
  }, [active, target, shown]);

  return shown;
}
