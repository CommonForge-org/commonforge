/**
 * Inline SVG icons (no icon dependency). One stroke style everywhere (24-unit grid, currentColor,
 * 1.8 stroke) so tree chips, cards, timeline nodes and video callouts read as one family.
 *
 * Object icons (docs/UX-POLISH.md §5): repository → `repo` (branch), assets → `assets` (image
 * stack), notes → `notes` (document), edition → `edition` (hand-over), agent → `agent` (spark),
 * human → `human` (person).
 */
import type { ReactElement } from "react";

const PATHS = {
  // navigation
  overview: (
    <>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v10h14V10" />
    </>
  ),
  files: <path d="M3 7h6l2 2h10v10H3z" />,
  changes: (
    <>
      <path d="M4 12h16" />
      <path d="M14 6l6 6-6 6" />
    </>
  ),
  versions: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  // objects
  repo: (
    <>
      <path d="M6 3v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  assets: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m21 15-5-4-9 8" />
    </>
  ),
  notes: (
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 13h7M8.5 17h5" />
    </>
  ),
  edition: (
    <>
      <path d="M3 14h4l3.5 3H15a1.5 1.5 0 0 0 0-3h-3" />
      <path d="M7 14V9.5L11 8l5 2.5" />
      <path d="M3 20h3l4 1 9-4" />
      <path d="M15 4h5v5" />
      <path d="M20 4l-6 6" />
    </>
  ),
  agent: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M12 8.5 13.2 10.8 15.5 12 13.2 13.2 12 15.5 10.8 13.2 8.5 12 10.8 10.8z" />
      <path d="m5.6 5.6 1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  human: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  // states and actions
  check: <path d="M20 6 9 17l-5-5" />,
  alert: (
    <>
      <path d="M12 8v5" />
      <circle cx="12" cy="16.5" r="0.8" fill="currentColor" />
      <path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </>
  ),
  cross: <path d="M18 6 6 18M6 6l12 12" />,
  lock: (
    <>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  inspector: <path d="M4 6h16M4 12h10M4 18h16" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a1 1 0 0 1 1-1h9" />
    </>
  ),
  close: <path d="M18 6 6 18M6 6l12 12" />,
  plus: <path d="M12 5v14M5 12h14" />,
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  repair: (
    <>
      <path d="M4 4v6h6" />
      <path d="M20 20v-6h-6" />
      <path d="M5 10a8 8 0 0 1 14-3" />
      <path d="M19 14a8 8 0 0 1-14 3" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13h5l1.5 3h5L16 13h5" />
      <path d="M5.5 5h13L21 13v6H3v-6z" />
    </>
  ),
  // editions (UX-2 Start an update cards)
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  // file changes (UX-2 return summary)
  pencil: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  arrow: (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ),
  message: <path d="M4 5h16v11H9l-5 4z" />,
  /** the org switcher: up/down chevrons */
  switch: <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />,
  /** an organization */
  org: (
    <>
      <path d="M4 21V5l8-2v18" />
      <path d="M12 9h8v12" />
      <path d="M3 21h18M8 8h.01M8 12h.01M8 16h.01M16 13h.01M16 17h.01" />
    </>
  ),
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** Decorative by default (`aria-hidden`); pass `label` when the icon alone carries meaning. */
export function Icon({ name, size = 18, strokeWidth = 1.8, label, className }: { name: IconName; size?: number; strokeWidth?: number; label?: string; className?: string }) {
  return (
    <svg
      className={`icon-svg ${className ?? ""}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: "false" })}
    >
      {PATHS[name]}
    </svg>
  );
}

export type ObjectKind = "repo" | "assets" | "notes" | "edition" | "agent" | "human";

/** The icon for a project resource: assets for R2 collections, notes for requirements/docs, else a repository. */
export function resourceIcon(provider: string, name = ""): ObjectKind {
  if (provider === "r2-assets") return "assets";
  if (/\b(requirements?|notes?|docs?|specs?)\b/i.test(name)) return "notes";
  return "repo";
}
