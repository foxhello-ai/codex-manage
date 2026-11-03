import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** Shared modal shell: only the body scrolls; dismissing never commits an action. */
export function BottomSheet({ title, description, children, actions, onClose, busy = false, className = "" }: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const currentRef = useRef({ onClose, busy });
  currentRef.current = { onClose, busy };

  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const siblings = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== containerRef.current);
    const previousInert = siblings.map((node) => node.inert);
    siblings.forEach((node) => { node.inert = true; });
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!currentRef.current.busy) currentRef.current.onClose();
      }
      if (event.key !== "Tab") return;
      event.stopPropagation();
      const controls = [...(containerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])]
        .filter((node) => node.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      siblings.forEach((node, index) => { node.inert = previousInert[index]!; });
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div className="sheetBackdrop" ref={containerRef} onClick={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className={`bottomSheet ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} aria-busy={busy}>
        <header className="sheetHeader">
          <div><h2 id={titleId}>{title}</h2>{description ? <p id={descriptionId}>{description}</p> : null}</div>
          <button ref={closeRef} className="iconButton" type="button" aria-label="关闭面板" onClick={onClose} disabled={busy}>×</button>
        </header>
        <div className="sheetBody">{children}</div>
        {actions ? <footer className="sheetActions">{actions}</footer> : null}
      </section>
    </div>, document.body
  );
}
