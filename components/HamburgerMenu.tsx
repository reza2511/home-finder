"use client";

import { useEffect, useRef, useState } from "react";

// Top-corner navigation menu — a dedicated menu component (rather than
// another header button) so pages beyond the home grid have somewhere to
// go without crowding app-header__actions.
export default function HamburgerMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onClickOutside);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onClickOutside);
    };
  }, [open]);

  return (
    <div className="hamburger-menu" ref={rootRef}>
      <button
        type="button"
        className="hamburger-menu__button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu"
      >
        ☰
      </button>
      {open && (
        <nav className="hamburger-menu__panel" role="menu">
          <a href="/" role="menuitem" className="hamburger-menu__item">
            Home
          </a>
          <a href="/compare" role="menuitem" className="hamburger-menu__item">
            Compare properties
          </a>
          <a href="/property-tracker" role="menuitem" className="hamburger-menu__item">
            Property Tracker
          </a>
          <a href="/favourites" role="menuitem" className="hamburger-menu__item">
            Favourites
          </a>
          <a href="/removed" role="menuitem" className="hamburger-menu__item">
            Removed items
          </a>
          <a href="/statistics" role="menuitem" className="hamburger-menu__item">
            Statistics
          </a>
          <a href="/postcode-map" role="menuitem" className="hamburger-menu__item">
            Postcode map
          </a>
        </nav>
      )}
    </div>
  );
}
