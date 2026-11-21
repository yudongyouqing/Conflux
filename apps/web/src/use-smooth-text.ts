import { useEffect, useRef, useState } from "react";

/**
 * Typewriter pacing for streaming text:
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
  const ref = useRef({ pos: 0, raf: 0, lastTs: 0, target });
  ref.current.target = target;

  useEffect(() => {
    const state = ref.current;
    if (!active || reduced) {
      if (state.raf) {
        cancelAnimationFrame(state.raf);
        state.raf = 0;
      }
      state.pos = target.length;
      setShown(target);
      return;
    }
    // target replaced wholesale (new message): restart from 0
    if (state.pos > target.length || !target.startsWith(shown)) {
      state.pos = 0;
      setShown("");
    }
    if (state.pos >= target.length) return; // nothing new yet
    if (state.raf) return; // animation loop already running for live target ref

    const tick = (ts: number) => {
      state.raf = 0;
      const curTarget = state.target;
      const dt = state.lastTs ? Math.min((ts - state.lastTs) / 1000, 0.25) : 0.016;
      state.lastTs = ts;
      const backlog = curTarget.length - state.pos;
      if (backlog <= 0) return;
      const cps = backlog > 30 ? Math.max(60, backlog / 0.5) : 60;
      let next = state.pos + Math.max(1, Math.round(cps * dt));
      // never race past the arriving target
      if (next > curTarget.length) next = curTarget.length;
      // code-point safety: if we stopped right after a UTF-16 high surrogate,
      // include its trailing low surrogate so 1-unit steps never stall on emoji
      if (next < curTarget.length && next > state.pos) {
        const code = curTarget.charCodeAt(next - 1);
        if (code >= 0xd800 && code <= 0xdbff) next += 1;
      }
      state.pos = next;
      setShown(curTarget.slice(0, next));
      if (next < curTarget.length) state.raf = requestAnimationFrame(tick);
      else state.lastTs = 0;
    };
    state.lastTs = 0;
    state.raf = requestAnimationFrame(tick);
    // shown deliberately excluded: pacing reads target/ref only
  }, [target, active, reduced]);

  useEffect(
    () => () => {
      if (ref.current.raf) {
        cancelAnimationFrame(ref.current.raf);
        ref.current.raf = 0;
      }
    },
    [],
  );

  return shown;
}
