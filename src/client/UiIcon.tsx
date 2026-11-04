import type { ReactNode } from "react";

const paths = {
  terminal: <><path d="m5 6 6 6-6 6M13 18h6" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  settings: <><path d="m9 3-.6 2.2-2 .9-2-.6-2 3.4 1.5 1.6v2.4l-1.5 1.6 2 3.4 2-.6 2 .9L9 21h4l.6-2.2 2-.9 2 .6 2-3.4-1.5-1.6v-2.4l1.5-1.6-2-3.4-2 .6-2-.9L13 3Z" /><circle cx="11" cy="12" r="3" /></>,
  logout: <><path d="M10 4H5v16h5M14 8l4 4-4 4M9 12h10" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16M5.5 8h1M5.5 12h1" /></>,
  pencil: <><path d="m15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-5-5L4 14Z" /></>,
  folder: <path d="M3 7V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Zm0 0h18" />,
  back: <path d="m14 5-7 7 7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
} satisfies Record<string, ReactNode>;

export function UiIcon({ name }: { name: keyof typeof paths }) {
  return <svg className="uiIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
