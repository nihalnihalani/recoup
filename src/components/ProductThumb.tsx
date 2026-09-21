import { useState } from "react";
import { StoreAvatar } from "./StoreAvatar";

type Props = {
  imageUrl: string | null | undefined;
  name: string;
  /** Edge length in px. */
  size?: number;
  /** When given, the store's own tile stands in for a missing picture. */
  domain?: string;
};

/**
 * A product's picture in a bordered square tile. The image is the store page's own
 * Open Graph image, requested without a referrer, and it is the only request made.
 * Until it arrives, and when it never does, the store's tile (if `domain` is known)
 * or a neutral box stands in: never a broken-image glyph.
 */
export function ProductThumb({ imageUrl, name, size = 40, domain }: Props) {
  // Keyed by URL, so a changed image gets a fresh attempt.
  const [seen, setSeen] = useState<{ url: string; state: "loaded" | "failed" } | null>(null);
  const url = typeof imageUrl === "string" && /^https:\/\//i.test(imageUrl) ? imageUrl : undefined;
  const state = url !== undefined && seen?.url === url ? seen.state : "pending";
  const showImage = url !== undefined && state !== "failed";
  const glyph = Math.round(size * 0.5);

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-gray-100 text-gray-400"
      style={{ width: size, height: size }}
    >
      {state !== "loaded" &&
        (domain ? (
          <StoreAvatar domain={domain} size={size} />
        ) : (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ width: glyph, height: glyph }}
          >
            <path d="M21 8.2 12 3 3 8.2v7.6L12 21l9-5.2V8.2Z" />
            <path d="M3.3 8.4 12 13.4l8.7-5M12 13.4V21" />
          </svg>
        ))}
      {showImage && (
        <img
          src={url}
          alt=""
          title={name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setSeen({ url, state: "loaded" })}
          onError={() => setSeen({ url, state: "failed" })}
          className={`absolute inset-0 size-full object-cover transition-opacity duration-300 motion-reduce:transition-none ${
            state === "loaded" ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </span>
  );
}
