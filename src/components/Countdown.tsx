import { useEffect, useState } from "react";

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** A live countdown to `endsAt` (epoch ms), ticking once a second. Reads "window closed" once past. */
export function Countdown({ endsAt, className = "" }: { endsAt: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = endsAt - now;

  if (remaining <= 0) {
    return <span className={`font-mono text-sm text-ink/50 ${className}`}>window closed</span>;
  }

  return (
    <span className={`font-mono text-sm tabular-nums text-ink ${className}`}>
      {formatRemaining(remaining)}
    </span>
  );
}
