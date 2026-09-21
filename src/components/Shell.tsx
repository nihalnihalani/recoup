import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { NotificationBell } from "./NotificationBell";
import { ThemeToggle } from "./ThemeToggle";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="size-6 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const NAV = [
  {
    to: "/",
    end: true,
    label: "Dashboard",
    icon: (
      <Icon>
        <path d="M4 19V10" />
        <path d="M10 19V5" />
        <path d="M16 19v-6" />
        <path d="M3 19h18" />
        <path d="M20 8l-3-3-3 3" />
      </Icon>
    ),
  },
  {
    to: "/watching",
    end: false,
    label: "Watching",
    icon: (
      <Icon>
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </Icon>
    ),
  },
  {
    to: "/settings",
    end: false,
    label: "Add purchase",
    icon: (
      <Icon>
        <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
        <path d="M4 8l8 6 8-6" />
      </Icon>
    ),
  },
] as const;

function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <svg className="size-8" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" className="fill-violet-500" />
        <path
          d="M8 11h5l3 5 3 5h5"
          fill="none"
          className="stroke-on-accent"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="24" cy="21" r="2.5" className="fill-on-accent" />
      </svg>
      <span className="text-lg font-bold text-gray-800">Recoup</span>
    </span>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity lg:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        id="sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col overflow-y-auto rounded-r-2xl bg-white p-4 shadow-xs transition-transform duration-200 lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-64"
        }`}
      >
        <div className="mb-10 flex items-center justify-between pr-1 pl-2 pt-1">
          <NavLink to="/" aria-label="Recoup dashboard" className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
            <Logo />
          </NavLink>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:text-gray-600 lg:hidden"
            aria-label="Close menu"
          >
            <Icon>
              <path d="M6 6l12 12M18 6L6 18" />
            </Icon>
          </button>
        </div>

        <nav aria-label="Primary">
          <h2 className="pl-3 text-xs font-semibold uppercase text-gray-400">Pages</h2>
          <ul className="mt-3 space-y-1">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-violet-500 ${
                      isActive
                        ? "bg-linear-to-r from-violet-500/[0.12] to-violet-500/[0.04] text-gray-800 [&_svg]:text-violet-500"
                        : "text-gray-600 hover:text-gray-900 [&_svg]:text-gray-400"
                    }`
                  }
                >
                  {item.icon}
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </>
  );
}

function UserMenu() {
  const { signOut } = useAuthActions();
  const me = useQuery(api.profiles.me);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const inbox = me?.inboxEmail ?? undefined;
  const initial = inbox ? inbox.charAt(0).toUpperCase() : undefined;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-violet-500 text-sm font-semibold text-on-accent">
          {initial ?? (
            <svg className="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20a8 8 0 0 1 16 0z" />
            </svg>
          )}
        </span>
        <span className="hidden text-sm font-medium text-gray-600 sm:block">Account</span>
        <svg className="size-3 text-gray-400" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <path d="M5.9 11.4L.5 6l1.4-1.4 4 4 4-4L11.3 6z" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-2 min-w-52 rounded-lg border border-gray-200 bg-white py-1.5 shadow-lg"
        >
          {inbox && (
            <div className="mb-1 border-b border-gray-200 px-3 pb-2 pt-0.5">
              <p className="text-xs font-semibold uppercase text-gray-400">Your Recoup inbox</p>
              <p className="mt-0.5 break-all text-sm font-medium text-gray-800">{inbox}</p>
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="flex w-full px-3 py-1.5 text-left text-sm font-medium text-violet-500 hover:text-violet-600"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** The app frame: white sidebar (off-canvas under lg), sticky blurred header, padded content column. */
export function Shell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { pathname } = useLocation();
  const [seenPath, setSeenPath] = useState(pathname);

  // Navigating closes the drawer.
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setSidebarOpen(false);
  }

  return (
    <div className="flex min-h-dvh bg-gray-100 text-gray-600">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 bg-gray-100/90 backdrop-blur-md">
          <div className="flex h-16 items-center justify-between px-4 sm:px-6 lg:px-8">
            <button
              type="button"
              className="rounded-lg p-1 text-gray-500 hover:text-gray-700 lg:hidden"
              aria-controls="sidebar"
              aria-expanded={sidebarOpen}
              aria-label="Open menu"
              onClick={() => setSidebarOpen(true)}
            >
              <Icon>
                <path d="M4 6h16M4 12h16M4 18h16" />
              </Icon>
            </button>
            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              <ThemeToggle />
              <NotificationBell />
              <span className="h-6 w-px bg-gray-200" aria-hidden="true" />
              <UserMenu />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[96rem] grow px-4 py-8 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
