import { useLayoutEffect } from "react";

// Safari can overlay its keyboard without resizing the layout viewport.
export function useVisualViewport() {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Preserve browser zoom; do not make the UI shrink to a pinched viewport.
        if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
        const height = viewport?.height ?? window.innerHeight;
        document.documentElement.style.setProperty("--app-height", `${height}px`);
        document.documentElement.dataset.compactHeight = String(height < 500);
        document.documentElement.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`);
      });
    }
    update();
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--app-height");
      document.documentElement.style.removeProperty("--app-top");
      delete document.documentElement.dataset.compactHeight;
    };
  }, []);
}
