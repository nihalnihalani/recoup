import { useLocation } from "react-router-dom";
import { NotificationBell } from "../NotificationBell";
import { MenuIcon, SearchIcon } from "./icons";
import { frameButtonClass, pageFor } from "./nav";

type Props = {
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  paletteOpen: boolean;
  onOpenPalette: () => void;
};

export function TopBar({ sidebarOpen, onOpenSidebar, paletteOpen, onOpenPalette }: Props) {
  const { pathname } = useLocation();
  const page = pageFor(pathname);

  return (
    <header className="sticky top-0 z-30 border-b border-gray-200 bg-white">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          className={`${frameButtonClass} lg:hidden`}
          aria-controls="sidebar"
          aria-expanded={sidebarOpen}
          aria-label="Open menu"
          onClick={onOpenSidebar}
        >
          <MenuIcon />
        </button>

        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex items-center gap-2 text-sm">
            <li className="hidden text-gray-400 sm:block">Main Menu</li>
            <li aria-hidden="true" className="hidden text-gray-300 sm:block">
              /
            </li>
            <li aria-current="page" className="flex min-w-0 items-center gap-1.5 font-semibold text-gray-900">
              {page.icon}
              <span className="truncate">{page.label}</span>
            </li>
          </ol>
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {/* Not a real input: it opens the palette, which owns the text field. */}
          <button
            type="button"
            onClick={onOpenPalette}
            aria-haspopup="dialog"
            aria-expanded={paletteOpen}
            aria-keyshortcuts="Meta+K Control+K"
            className="hidden h-10 w-64 items-center gap-2.5 rounded-xl border border-gray-200 bg-white px-3 text-left text-sm text-gray-400 outline-none transition hover:border-gray-300 focus-visible:ring-2 focus-visible:ring-violet-500 md:flex xl:w-80"
          >
            <SearchIcon className="size-[18px] text-gray-500" />
            <span className="flex-1 truncate">Search anything…</span>
            <kbd className="rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-gray-500">
              ⌘K
            </kbd>
          </button>
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label="Search"
            aria-haspopup="dialog"
            aria-expanded={paletteOpen}
            className={`${frameButtonClass} md:hidden`}
          >
            <SearchIcon />
          </button>
          <NotificationBell />
        </div>
      </div>
    </header>
  );
}
