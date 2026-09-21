import { useEffect, useRef, useState } from "react";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Eases a number from where it stands to `target`. Jumps straight there under reduced motion. */
export function useCountUp(target: number, ms = 900): number {
  const [value, setValue] = useState(() => (reducedMotion() ? target : 0));
  const current = useRef(value);

  useEffect(() => {
    const origin = current.current;
    const still = reducedMotion() || origin === target;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(time) {
      const k = still ? 1 : Math.min(1, Math.max(0, (time - start) / ms));
      const next = origin + (target - origin) * (1 - (1 - k) ** 3);
      current.current = next;
      setValue(next);
      if (k < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);

  return value;
}
