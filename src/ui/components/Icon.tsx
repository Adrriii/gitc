/**
 * The icon set.
 *
 * Drawn here rather than pulled from a library: gitc ships as a single binary
 * with no network, so an icon font or sprite sheet would have to be embedded
 * anyway - and these are simple enough that the geometry is smaller than the
 * dependency would be.
 *
 * All of them share one language so they read as a set: a 24x24 box, stroked
 * with currentColor at width 2, round caps and joins, no fills. Stroking with
 * currentColor is what lets a disabled button, a hovered row and a coloured
 * status glyph all use the same icon without variants.
 */

export type IconName =
  | "fetch"
  | "pull"
  | "push"
  | "gear"
  | "kebab"
  | "eye"
  | "eyeOff"
  | "folder"
  | "branch"
  | "stash"
  | "pop"
  | "close"
  | "plus"
  | "chevronRight"
  | "chevronDown"
  | "tag"
  | "cloud"
  | "check"
  | "trash"
  | "edit"
  | "file"
  | "added"
  | "removed"
  | "repo"
  | "search"
  | "unified"
  | "inline"
  | "split"
  | "pilcrow"
  | "wrap"
  | "arrowUp"
  | "arrowDown"
  | "warning"
  | "monitor";

const PATHS: Record<IconName, React.ReactNode> = {
  // Circular arrow: fetching is a round trip, not a direction.
  fetch: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
      <path d="M20.5 3.5V6H18" />
    </>
  ),
  pull: (
    <>
      <path d="M12 3v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4 20h16" />
    </>
  ),
  push: (
    <>
      <path d="M12 21V10" />
      <path d="M7.5 13.5 12 9l4.5 4.5" />
      <path d="M4 4h16" />
    </>
  ),
  // Two nodes and a line: the graph's own shape, at icon scale.
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.6v2.6M12 18.8v2.6M21.4 12h-2.6M5.2 12H2.6M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8M18.6 18.6l-1.8-1.8M7.2 7.2L5.4 5.4" />
    </>
  ),
  kebab: (
    <>
      <circle cx="12" cy="5" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="19" r="1.4" />
    </>
  ),
  eye: (
    <>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </>
  ),
  folder: (
    <>
      <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h8A1.5 1.5 0 0 1 20 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 18.5z" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="6" r="2.2" />
      <path d="M7 8.2v7.6" />
      <path d="M17 8.2v1.3a4 4 0 0 1-4 4H9" />
    </>
  ),
  stash: (
    <>
      <path d="M4 9h16v10H4z" />
      <path d="M3 5h18v4H3z" />
      <path d="M12 11.5v4.5" />
      <path d="M10 14l2 2 2-2" />
    </>
  ),
  pop: (
    <>
      <path d="M4 9h16v10H4z" />
      <path d="M3 5h18v4H3z" />
      <path d="M12 16.5V12" />
      <path d="M10 14l2-2 2 2" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  chevronRight: <path d="M9 5l7 7-7 7" />,
  chevronDown: <path d="M5 9l7 7 7-7" />,
  tag: (
    <>
      <path d="M3 11.5V4h7.5L21 14.5 14.5 21 3 11.5z" />
      <circle cx="7.5" cy="7.5" r="1.3" />
    </>
  ),
  cloud: <path d="M6.5 19a4 4 0 0 1 .4-8 5.5 5.5 0 0 1 10.5 1.4A3.6 3.6 0 0 1 17.5 19z" />,
  check: <path d="M4.5 12.5l5 5 10-10" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L20 8l-4-4L4 16z" />
      <path d="M14 6l4 4" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M14 3v5h5" />
    </>
  ),
  added: (
    <>
      <path d="M12 6v12" />
      <path d="M6 12h12" />
    </>
  ),
  removed: <path d="M6 12h12" />,
  repo: (
    <>
      <path d="M5 4h14v16H8a3 3 0 0 1-3-3z" />
      <path d="M5 17a3 3 0 0 1 3-3h11" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5L20 20" />
    </>
  ),
  // The three diff modes, drawn to differ at a glance rather than in detail.
  unified: (
    <>
      <path d="M4 5h16v14H4z" />
      <path d="M4 12h16" />
    </>
  ),
  inline: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h10" />
    </>
  ),
  split: (
    <>
      <path d="M4 5h16v14H4z" />
      <path d="M12 5v14" />
    </>
  ),
  pilcrow: (
    <>
      <path d="M13 4v16" />
      <path d="M17 4v16" />
      <path d="M13 4h-2.5a3.5 3.5 0 0 0 0 7H13" />
    </>
  ),
  wrap: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h12a3 3 0 0 1 0 6h-3" />
      <path d="M15 15l-2 3 2 3" />
    </>
  ),
  arrowUp: (
    <>
      <path d="M12 20V5" />
      <path d="M6 11l6-6 6 6" />
    </>
  ),
  arrowDown: (
    <>
      <path d="M12 4v15" />
      <path d="M6 13l6 6 6-6" />
    </>
  ),
  // "this branch exists on your machine"
  monitor: (
    <>
      <path d="M3 5h18v11H3z" />
      <path d="M9 20h6" />
      <path d="M12 16v4" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.5 22 20H2z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.4v.2" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  strokeWidth = 2,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
