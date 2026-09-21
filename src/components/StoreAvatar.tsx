import { useState } from "react";
import { normalizeDomain, storeInfo } from "../lib/stores";

const TINTS = [
  "bg-violet-500/15 text-violet-700",
  "bg-sky-500/15 text-sky-700",
  "bg-green-500/15 text-green-700",
  "bg-yellow-500/15 text-yellow-700",
  "bg-red-500/15 text-red-700",
] as const;

function tintFor(domain: string): string {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  return TINTS[hash % TINTS.length];
}

/**
 * A store's tile. The icon is requested from the store's own domain only, never a
 * third-party favicon service, which would learn the user's store list. When it
 * fails to load, a letter on a tint picked from the domain stands in. A loaded icon
 * sits on `tile`, which stays light in the dark theme because most store marks are dark.
 */
export function StoreAvatar({ domain, size = 36 }: { domain: string; size?: number }) {
  const host = normalizeDomain(domain);
  // Keyed by host, so a changed `domain` prop gets a fresh attempt.
  const [icon, setIcon] = useState<{ host: string; state: "loaded" | "failed" } | null>(null);
  const state = icon?.host === host ? icon.state : "pending";
  const name = storeInfo(host).name;
  // Reserved TLDs (the example data's northwind.example) never resolve: skip the request.
  const usable = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && !/\.(example|test|invalid|localhost)$/.test(host);
  const iconSize = Math.round(size * 0.56);

  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg font-semibold ${
        state === "loaded" ? "bg-tile" : tintFor(host)
      }`}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)) }}
    >
      {/* The letter holds the tile until the store's own icon has actually arrived. */}
      {state !== "loaded" && name.charAt(0).toUpperCase()}
      {usable && state !== "failed" && (
        <img
          src={`https://${host}/favicon.ico`}
          alt=""
          width={iconSize}
          height={iconSize}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setIcon({ host, state: "loaded" })}
          onError={() => setIcon({ host, state: "failed" })}
          className={`absolute object-contain ${state === "loaded" ? "" : "opacity-0"}`}
        />
      )}
    </span>
  );
}
