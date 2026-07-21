import type { CodexDesktopApi } from "../shared/types";

declare global {
  interface Window {
    codexDesktop: CodexDesktopApi;
  }
}

export {};
