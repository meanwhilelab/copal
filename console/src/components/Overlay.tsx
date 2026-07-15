import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

type Align = "center" | "end" | "top";

/**
 * Modal scrim + panel with correct dialog semantics:
 * - Escape closes it (each overlay handles its own key, innermost first).
 * - Clicking the scrim closes it, but a drag that STARTS inside the panel and
 *   releases on the scrim does not (mousedown-origin tracking) — so selecting
 *   text and drifting past the edge no longer dismisses the panel.
 * - role="dialog" aria-modal, panel focused on mount for keyboard users.
 */
export function Overlay({
  onClose,
  align = "center",
  z = 50,
  panelClassName,
  panelStyle,
  children,
}: {
  onClose: () => void;
  align?: Align;
  z?: number;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimDown = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const justify =
    align === "end" ? "justify-end" : align === "top" ? "justify-center pt-20" : "items-center justify-center";

  return (
    <div
      className={`absolute inset-0 flex ${justify}`}
      style={{ zIndex: z, background: "var(--scrim)", backdropFilter: "blur(3px)" }}
      onMouseDown={(e) => {
        scrimDown.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (scrimDown.current && e.target === e.currentTarget) onClose();
        scrimDown.current = false;
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`outline-none ${panelClassName ?? ""}`}
        style={panelStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
