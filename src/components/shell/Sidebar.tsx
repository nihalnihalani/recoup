import { useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { CloseIcon, PanelIcon } from "./icons";
import { NAV } from "./nav";
import { UserCard } from "./UserCard";

const smallButtonClass =
  "flex size-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 outline-none transition hover:bg-gray-50 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500";

type Props = {
  /** Off-canvas drawer state, under lg only. */
  open: boolean;
  onClose: () => void;
  /** Icon-rail state, lg and up only. The drawer is always full width. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

export function Sidebar({ open, onClose, collapsed, onToggleCollapsed }: Props) {
  const closeButton = useRef<HTMLButtonElement | null>(null);

  // The drawer is modal on small screens: take focus on open, close on Escape.
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const hideWhenRail = collapsed ? "lg:sr-only" : "";

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
        aria-label="Sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex w-[260px] shrink-0 flex-col border-r border-gray-200 bg-white transition-[translate,width] duration-200 motion-reduce:transition-none lg:visible lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0 ${
          open ? "translate-x-0" : "invisible -translate-x-full"
        } ${collapsed ? "lg:w-[76px]" : ""}`}
      >
        <div
          className={`flex h-16 shrink-0 items-center justify-between gap-2 px-4 ${
            collapsed ? "lg:h-auto lg:flex-col lg:gap-3 lg:px-0 lg:pt-4" : ""
          }`}
        >
          <NavLink
            to="/"
            aria-label="Recoup dashboard"
            className="flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-lg bg-gray-900 text-lg font-bold leading-none text-paper"
            >
              R
            </span>
            <span className={`text-xl font-semibold tracking-tight text-gray-900 ${collapsed ? "lg:hidden" : ""}`}>Recoup</span>
          </NavLink>

          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-pressed={collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`${smallButtonClass} hidden lg:flex`}
          >
            <PanelIcon className="size-4" />
          </button>
          <button ref={closeButton} type="button" onClick={onClose} aria-label="Close menu" className={`${smallButtonClass} lg:hidden`}>
            <CloseIcon className="size-4" />
          </button>
        </div>

        <nav aria-label="Primary" className={`min-h-0 flex-1 overflow-y-auto px-4 pt-5 ${collapsed ? "lg:px-3" : ""}`}>
          {/* F-T20-1: text-gray-400 on white measured 2.6:1 (WCAG AA needs 4.5:1 for
              normal text); text-gray-600 measures 7.56:1 here (#4a5565 on #ffffff),
              still visibly lighter than the gray-700/900 used for active/emphasised
              text below so the hierarchy is unchanged. */}
          <h2 className={`px-3 text-xs font-medium uppercase tracking-wide text-gray-600 ${hideWhenRail}`}>Main menu</h2>
          <ul className="mt-3 space-y-1">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    `flex h-11 items-center gap-3 rounded-xl border px-3 text-[15px] outline-none transition focus-visible:ring-2 focus-visible:ring-violet-500 ${
                      collapsed ? "lg:justify-center lg:px-0" : ""
                    } ${
                      isActive
                        ? "border-gray-200 bg-white font-semibold text-gray-900 shadow-[0_1px_2px_rgb(0_0_0/0.06)]"
                        : "border-transparent font-medium text-gray-700 hover:bg-gray-50 hover:text-gray-900 [&_svg]:text-gray-500"
                    }`
                  }
                >
                  {item.icon}
                  <span className={hideWhenRail}>{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className={`shrink-0 p-4 ${collapsed ? "lg:px-3" : ""}`}>
          <UserCard collapsed={collapsed} />
        </div>
      </aside>
    </>
  );
}
