import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { SettingsIcon, SignOutIcon } from "./icons";

/** Up to two letters from the part of the address before the @, split on separators. */
function initialsOf(email: string): string {
  const parts = email.split("@")[0].split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "";
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0].charAt(0) + parts[1].charAt(0);
  return letters.toUpperCase();
}

/**
 * The account card at the foot of the sidebar. The only account detail the client can
 * read is the user's Recoup inbox address (`profiles.me`), so that is what it shows.
 */
export function UserCard({ collapsed }: { collapsed: boolean }) {
  const { signOut } = useAuthActions();
  const me = useQuery(api.profiles.me);
  const inbox = me?.inboxEmail ?? undefined;
  const initials = inbox ? initialsOf(inbox) : "";

  return (
    <div
      className={`flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-2.5 ${
        collapsed ? "lg:flex-col lg:gap-2 lg:border-transparent lg:p-0" : ""
      }`}
    >
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gray-900 text-sm font-semibold text-paper"
      >
        {initials || (
          <svg className="size-4" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20a8 8 0 0 1 16 0z" />
          </svg>
        )}
      </span>
      <div className={`min-w-0 flex-1 ${collapsed ? "lg:hidden" : ""}`}>
        <p className="truncate text-sm font-semibold text-gray-900">Your account</p>
        <p className="truncate text-xs text-gray-400" title={inbox}>
          {inbox ?? (me === undefined ? "Loading…" : "Inbox not set up yet")}
        </p>
      </div>
      <Link
        to="/settings"
        aria-label="Settings"
        title="Settings"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-gray-500 outline-none transition hover:bg-gray-50 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500"
      >
        <SettingsIcon />
      </Link>
      <button
        type="button"
        onClick={() => void signOut()}
        aria-label="Sign out"
        title="Sign out"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-gray-500 outline-none transition hover:bg-gray-50 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500"
      >
        <SignOutIcon />
      </button>
    </div>
  );
}
