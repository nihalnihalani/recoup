import { useAuthActions } from "@convex-dev/auth/react";
import { NavLink, Outlet } from "react-router-dom";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium transition ${
    isActive ? "bg-ink text-paper" : "text-ink/70 hover:bg-ink/5 hover:text-ink"
  }`;

export function Shell() {
  const { signOut } = useAuthActions();

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <NavLink to="/" className="font-serif text-xl font-semibold tracking-tight text-ink">
            Recoup
          </NavLink>
          <nav className="flex items-center gap-1" aria-label="Primary">
            <NavLink to="/" end className={navLinkClass}>
              Board
            </NavLink>
            <NavLink to="/settings" className={navLinkClass}>
              Inbox
            </NavLink>
          </nav>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink/70 transition hover:border-ink/30 hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
