import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { Commit, GraphPayload, GraphRow, Person } from "../types";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { groupRefs } from "../refGroups";
import type { RefGroup } from "../refGroups";
import s from "./Graph.module.scss";

// Measured against a reference implementation over CDP, not guessed - see
// docs/ui-spec.md. Row pitch 28, lane pitch 22, commit node 22px with a 2px
// ring; merge commits get a smaller solid dot instead.
const ROW_H = 26;
const LANE_W = 22;
const NODE_R = 10;
const MERGE_R = 6;
const PAD_X = 14;
const OVERSCAN = 12;
const CORNER = 7;
/** Default width of the branch/tag column; draggable like the graph column. */
const CHIPS_W_DEFAULT = 128;
const CHIPS_W_MIN = 40;
const CHIPS_W_MAX = 420;
const CHIPS_W_KEY = "gitc.chipsWidth";
/** Node diameter, and how much of each stacked face shows collapsed/expanded. */
const NODE_SIZE = 22;
const PILE_COLLAPSED = 7;
const PILE_EXPANDED = 20;
/** Beyond this, the rest become a "+N" chip rather than more faces. */
const PILE_MAX = 3;

// The graph column sizes to the rows ON SCREEN, not to the deepest lane in
// history. A 12k-commit repo can reach 25 lanes somewhere near the bottom;
// reserving 25 * 22px for that leaves most of the column empty everywhere
// else. Dragging the divider pins a manual width; double-clicking it returns
// to automatic.
const GRAPH_W_MIN = 60;
const GRAPH_W_MAX = 900;
const GRAPH_W_KEY = "gitc.graphWidth";

/**
 * Connector geometry.
 *
 * Lane changes route orthogonally - a straight run, a rounded right-angle,
 * then a straight run - rather than sweeping diagonally across
 * the row. The difference matters: elbows keep every lane on an exact column
 * so the eye can follow one straight down a busy graph, where diagonals blur
 * the columns together.
 */

/** Leaves the commit dot, runs sideways, then turns down into `toX`. */
function elbowDown(fromX: number, toX: number, mid: number, h: number): string {
  const dir = toX > fromX ? 1 : -1;
  const r = Math.min(CORNER, Math.abs(toX - fromX) / 2, h - mid);
  if (r <= 0.5) return `M${fromX},${mid} V${h}`;
  return `M${fromX},${mid} H${toX - dir * r} Q${toX},${mid} ${toX},${mid + r} V${h}`;
}

/** Comes down `fromX` from above, turns, then runs sideways into the dot. */
function elbowUp(fromX: number, toX: number, mid: number): string {
  const dir = toX > fromX ? 1 : -1;
  const r = Math.min(CORNER, Math.abs(toX - fromX) / 2, mid);
  if (r <= 0.5) return `M${fromX},0 V${mid}`;
  return `M${fromX},0 V${mid - r} Q${fromX},${mid} ${fromX + dir * r},${mid} H${toX}`;
}

/** Horizontal centre of a lane, in the row's own SVG coordinate space. */
function laneX(lane: number): number {
  return PAD_X + lane * LANE_W;
}

/**
 * One row's worth of graph.
 *
 * Drawing per row rather than one path per branch means the viewport only
 * ever renders what it shows - a 50k-commit repo costs the same as a 50-commit
 * one. The trade is that every crossing line has to be re-derived per row,
 * which is what `through` carries.
 */
function RowGraph({
  row,
  colors,
  wip,
  merge,
}: {
  row: GraphRow;
  colors: string[];
  wip?: boolean;
  merge?: boolean;
}) {
  const width = (row.width + 1) * LANE_W + PAD_X * 2;
  const mid = ROW_H / 2;
  const x = laneX(row.lane);
  const colorOf = (i: number) => colors[i % colors.length];

  return (
    <svg width={width} height={ROW_H} className={s.svg}>
      {/* Lines that neither begin nor end here. */}
      {row.through.map((t, i) => (
        <path
          key={`t${i}`}
          d={`M${laneX(t.lane)},0 V${ROW_H}`}
          stroke={colorOf(t.color)}
          strokeWidth={2}
          fill="none"
        />
      ))}

      {/* Branches converging into this commit, drawn in the top half. */}
      {row.merges.map((m, i) => (
        <path
          key={`m${i}`}
          d={elbowUp(laneX(m.from), x, mid)}
          stroke={colorOf(m.color)}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />
      ))}

      {/* Extra parents leaving this commit, drawn in the bottom half. */}
      {row.forks.map((f, i) => (
        <path
          key={`f${i}`}
          d={elbowDown(x, laneX(f.to), mid, ROW_H)}
          stroke={colorOf(f.color)}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />
      ))}

      {row.hasTop && (
        <path d={`M${x},0 V${mid}`} stroke={colorOf(row.color)} strokeWidth={2} fill="none" />
      )}
      {row.hasBottom && (
        <path d={`M${x},${mid} V${ROW_H}`} stroke={colorOf(row.color)} strokeWidth={2} fill="none" />
      )}

      {merge && !wip && (
        // Merge commits render as a small solid dot, matching the reference.
        <circle cx={x} cy={mid} r={MERGE_R} fill={colorOf(row.color)} />
      )}
      {wip && (
        <circle
          cx={x}
          cy={mid}
          r={NODE_R}
          fill="var(--bg-0)"
          stroke={colorOf(row.color)}
          strokeWidth={2}
          strokeDasharray="3 3"
        />
      )}
    </svg>
  );
}

/**
 * The commit node, plus a face for each co-author.
 *
 * A divergence from the reference, which shows one author and hides the rest.
 * git records co-authorship as a message trailer, so a commit really can have
 * several people behind it, and the graph is where you scan for who did what.
 *
 * Two constraints shape it:
 *
 *  - It must cost no layout width. The whole stack is absolutely positioned on
 *    the row, so it contributes nothing to the graph column's measured size -
 *    the column is exactly as wide as it would be with a single face.
 *  - It lives in the lane-coloured band between the node and the colour strip,
 *    which is otherwise empty space.
 *
 * Collapsed, the faces overlap so only a sliver of each shows. Hovering the
 * row fans them out into that band.
 */
function CommitNode({
  x,
  color,
  author,
  email,
  coAuthors,
  bandWidth,
  chipsWidth,
}: {
  x: number;
  color: string;
  author: string;
  email: string;
  coAuthors: Person[];
  /** Space from the node to the colour strip - the band it may expand into. */
  bandWidth: number;
  /** Width of the branch column the stack is offset past. */
  chipsWidth: number;
}) {
  const shown = coAuthors.slice(0, PILE_MAX);
  const extra = coAuthors.length - shown.length;
  const items = 1 + shown.length + (extra > 0 ? 1 : 0);

  // The fan-out is sized to the band rather than fixed, so it never reaches
  // past the colour strip and over the commit message. A narrow graph column
  // simply expands less.
  const room = Math.max(0, bandWidth - NODE_SIZE);
  const gap =
    items > 1
      ? Math.max(PILE_COLLAPSED, Math.min(PILE_EXPANDED, room / (items - 1)))
      : PILE_EXPANDED;

  return (
    <span
      className={s.nodeStack}
      style={
        {
          left: chipsWidth + x - NODE_R - 1,
          "--pile-gap": `${Math.round(gap)}px`,
        } as React.CSSProperties
      }
      data-count={coAuthors.length}
    >
      <span className={s.pileItem} style={{ zIndex: 20 }}>
        <Avatar name={author} email={email} size={22} ringColor={color} />
      </span>
      {shown.map((p, i) => (
        <span
          key={p.email + p.name}
          className={s.pileItem}
          // Descending so the author stays in front and each face tucks
          // behind the one before it.
          style={{ zIndex: 19 - i, marginLeft: -(22 - PILE_COLLAPSED) }}
        >
          <Avatar name={p.name} email={p.email} size={22} ringColor={color} />
        </span>
      ))}
      {extra > 0 && (
        <span
          className={s.pileItem}
          style={{ zIndex: 19 - shown.length, marginLeft: -(22 - PILE_COLLAPSED) }}
          title={coAuthors
            .slice(PILE_MAX)
            .map((p) => p.name)
            .join(", ")}
        >
          <span className={s.pileMore} style={{ borderColor: color }}>
            +{extra}
          </span>
        </span>
      )}
    </span>
  );
}

/** Where a branch of this name exists: on disk, and on which remotes. */
function Where({ group }: { group: RefGroup }) {
  if (group.kind === "tag") return null;
  return (
    <>
      {group.local && (
        <Icon name="monitor" size={11} className={s.whereIco} />
      )}
      {group.remotes.map((r) => (
        <Icon key={r} name="cloud" size={11} className={s.whereIco} />
      ))}
    </>
  );
}

function GroupChip({
  group,
  onContext,
  onCheckout,
}: {
  group: RefGroup;
  onContext: (kind: string, name: string, x: number, y: number) => void;
  onCheckout: (kind: string, name: string) => void;
}) {
  const cls =
    group.kind === "tag" ? s.chipTag : group.local ? s.chipLocal : s.chipRemote;
  const where =
    group.kind === "tag"
      ? "tag"
      : [group.local ? "local" : null, ...group.remotes]
          .filter(Boolean)
          .join(", ");
  return (
    <span
      className={`${s.chip} ${cls} ${group.isHead ? s.chipHead : ""}`}
      title={`${group.name} — ${where}${group.isHead ? " — checked out" : ""}
double-click to check out, right-click for actions`}
      onDoubleClick={() => onCheckout(group.actionKind, group.actionName)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContext(group.actionKind, group.actionName, e.clientX, e.clientY);
      }}
    >
      {group.isHead && <Icon name="check" size={11} className={s.chipIco} />}
      {!group.isHead && group.kind === "tag" && (
        <Icon name="tag" size={11} className={s.chipIco} />
      )}
      <span className={s.chipName}>{group.name}</span>
      <Where group={group} />
    </span>
  );
}

/**
 * The WIP row's commit box.
 *
 * It sits exactly where the subject line would be once these changes are a
 * commit, so the row reads as the commit it is about to become rather than as
 * a separate piece of UI. Enter commits what is staged; the placeholder says
 * so when nothing is.
 */
function QuickCommit({
  staged,
  onCommit,
}: {
  staged: number;
  onCommit: (summary: string) => void;
}) {
  const [value, setValue] = useState("");
  const ready = staged > 0 && value.trim().length > 0;

  return (
    <input
      className={s.wipInput}
      value={value}
      placeholder="// WIP"
      title={
        staged > 0
          ? `Commit ${staged} staged file${staged === 1 ? "" : "s"}`
          : "Stage something first, in the panel on the right"
      }
      onChange={(e) => setValue(e.target.value)}
      // The row's click handler would steal focus back on every keystroke.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && ready) {
          onCommit(value.trim());
          setValue("");
        }
        if (e.key === "Escape") setValue("");
      }}
    />
  );
}

/**
 * The branch/tag column for one row.
 *
 * Only the first group is shown - HEAD when it is here, so the branch you are
 * on never hides - and the rest collapse into a "+N". Hovering opens the full
 * list downward, where each entry can be checked out or right-clicked. The
 * list is rendered here rather than in a portal so it tracks the row it
 * belongs to while the graph scrolls.
 */
function RefCell({
  width,
  labels,
  headBranch,
  menuOpen,
  onContext,
  onCheckout,
}: {
  width: number;
  labels: string[];
  headBranch: string | null;
  /** True while a context menu is showing anywhere in the app. */
  menuOpen: boolean;
  onContext: (kind: string, name: string, x: number, y: number) => void;
  onCheckout: (kind: string, name: string) => void;
}) {
  const groups = useMemo(() => groupRefs(labels, headBranch), [labels, headBranch]);
  const [hovered, setHovered] = useState(false);
  // Right-clicking an entry opens a menu, which moves the pointer off the
  // list. On plain :hover the list would vanish underneath the menu it just
  // opened, leaving the menu pointing at nothing. So opening a menu pins it.
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!menuOpen) setPinned(false);
  }, [menuOpen]);

  if (groups.length === 0) return <div className={s.chipsCell} style={{ width }} />;

  const [first, ...rest] = groups;
  const showList = rest.length > 0 && (hovered || pinned);

  return (
    <div
      className={`${s.chipsCell} ${showList ? s.chipsCellOpen : ""}`}
      style={{ width }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={s.chips} style={{ width }}>
        <GroupChip group={first} onContext={onContext} onCheckout={onCheckout} />
        {rest.length > 0 && <span className={s.overflowCount}>+{rest.length}</span>}
      </div>

      {showList && (
        <div className={s.refPop}>
          {groups.map((g) => (
            <div
              key={g.kind + g.name}
              className={`${s.popRow} ${g.isHead ? s.popRowHead : ""}`}
              title={`${g.name} — double-click to check out, right-click for actions`}
              onDoubleClick={() => onCheckout(g.actionKind, g.actionName)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setPinned(true);
                onContext(g.actionKind, g.actionName, e.clientX, e.clientY);
              }}
            >
              <span className={s.popTick}>
                {g.isHead && <Icon name="check" size={11} />}
              </span>
              <span className={s.popName}>{g.name}</span>
              <Where group={g} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Coarse buckets matching the reference's right-hand time markers. */
function bucket(date: number, now: number): string {
  const secs = now - date;
  const hours = Math.floor(secs / 3600);
  if (hours < 1) return "just now";
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks === 1 ? "a week ago" : `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "a month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "a year ago" : `${years} years ago`;
}

export function Graph({
  data,
  selected,
  onSelect,
  onContext,
  onRefContext,
  onRefCheckout,
  onQuickCommit,
  menuOpen,
}: {
  data: GraphPayload;
  selected: string[];
  onSelect: (hash: string, additive: boolean, range: boolean) => void;
  onContext: (hash: string, x: number, y: number) => void;
  /** Right-click on a branch or tag chip drawn on a row. */
  onRefContext: (kind: string, name: string, x: number, y: number) => void;
  /** Double-click a chip, or click one in the overflow list. */
  onRefCheckout: (kind: string, name: string) => void;
  /** Commit the staged changes with this summary, from the WIP row. */
  onQuickCommit: (summary: string) => void;
  /** True while a context menu is showing, so hover lists can stay pinned. */
  menuOpen: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(800);

  const hasWip = data.status.length > 0;
  const now = Math.floor(Date.now() / 1000);

  // The WIP node is synthetic: it isn't a commit, but it occupies row 0 and
  // sits on the checked-out branch's lane so the line reads continuously.
  const total = data.commits.length + (hasWip ? 1 : 0);

  const markers = useMemo(() => {
    // Topological order is not chronological - a merged branch's commits can
    // be much older than the rows around them. Emitting a marker on every
    // bucket change would make the column flicker between "2 hours ago" and
    // "yesterday" and back. Only mark when we cross into an older bucket than
    // anything shown so far, so the column reads as a monotonic timeline.
    const out = new Map<number, string>();
    let deepest = -1;
    data.commits.forEach((c, i) => {
      const age = now - c.date;
      if (age > deepest) {
        const b = bucket(c.date, now);
        if (out.size === 0 || [...out.values()].pop() !== b) out.set(i, b);
        deepest = age;
      }
    });
    return out;
  }, [data.commits, now]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setHeight(el.clientHeight);
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // The lane tint is a band, not a row background: it runs from the commit's
  // own dot across to the colour strip, 22px tall inside the 28px row.
  //
  // Selecting a commit does not replace the band, it BRIGHTENS it. Both
  // alphas were solved from reference pixels against the #1c1e23 base:
  // unselected lands on 0.10, selected on 0.50, consistently across every
  // channel of both the cyan and purple lanes. The blue selection wash is a
  // separate thing and applies only right of the strip.
  const tintOf = useCallback(
    (colorIndex: number, selected: boolean) =>
      data.colors[colorIndex % data.colors.length] + (selected ? "80" : "1a"),
    [data.colors],
  );

  // Width needed by the rows currently in view (first..last already includes
  // the overscan, so the column is sized slightly ahead of the scroll).
  const visibleWidth = useMemo(() => {
    let max = 0;
    for (let i = first; i < last; i++) {
      const ci = hasWip ? i - 1 : i;
      const r = data.rows[ci];
      if (r !== undefined && r.width > max) max = r.width;
    }
    return Math.max(GRAPH_W_MIN, (max + 1) * LANE_W + PAD_X * 2);
  }, [data.rows, first, last, hasWip]);

  // Width the whole history would need - only used for the tooltip.
  const naturalWidth = useMemo(() => {
    let max = 0;
    for (const r of data.rows) if (r.width > max) max = r.width;
    return (max + 1) * LANE_W + PAD_X * 2;
  }, [data.rows]);

  const [userWidth, setUserWidth] = useState<number | null>(() => {
    const saved = localStorage.getItem(GRAPH_W_KEY);
    return saved === null ? null : Number(saved);
  });

  // The branch/tag column is dragged the same way, and simply remembers a
  // width - unlike the graph column it has no sensible automatic size, since
  // branch names are as long as they are.
  const [chipsWidth, setChipsWidth] = useState<number>(() => {
    const saved = localStorage.getItem(CHIPS_W_KEY);
    return saved === null ? CHIPS_W_DEFAULT : Number(saved);
  });

  const startChipsResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = chipsWidth;
      const onMove = (ev: MouseEvent) => {
        setChipsWidth(
          Math.max(CHIPS_W_MIN, Math.min(CHIPS_W_MAX, startW + ev.clientX - startX)),
        );
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setChipsWidth((w) => {
          localStorage.setItem(CHIPS_W_KEY, String(w));
          return w;
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [chipsWidth],
  );

  // Manual width wins once set; otherwise follow the viewport.
  const graphWidth = userWidth ?? visibleWidth;

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = graphWidth;
      const onMove = (ev: MouseEvent) => {
        const next = Math.max(
          GRAPH_W_MIN,
          Math.min(GRAPH_W_MAX, startW + ev.clientX - startX),
        );
        setUserWidth(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setUserWidth((w) => {
          if (w !== null) localStorage.setItem(GRAPH_W_KEY, String(w));
          return w;
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [graphWidth],
  );

  // Double-click the divider to hand the column back to automatic sizing.
  const fitWidth = useCallback(() => {
    setUserWidth(null);
    localStorage.removeItem(GRAPH_W_KEY);
  }, []);

  const rows: React.ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const wipRow = hasWip && i === 0;
    const ci = hasWip ? i - 1 : i;

    if (wipRow) {
      const headLane = data.rows.length > 0 ? data.rows[0].lane : 0;
      const headColor = data.rows.length > 0 ? data.rows[0].color : 0;
      const modified = data.status.filter((f) => !f.untracked).length;
      const added = data.status.filter((f) => f.untracked).length;
      const staged = data.status.filter((f) => f.staged).length;
      rows.push(
        <div
          key="wip"
          className={`${s.row} ${s.wip} ${selectedSet.has("WIP") ? s.sel : ""}`}
          style={{ top: 0 }}
          onClick={() => onSelect("WIP", false, false)}
        >
          <div className={s.chips} style={{ width: chipsWidth }} />
          <div className={s.graphCell} style={{ width: graphWidth }}>
            <RowGraph
              row={{
                hash: "WIP",
                lane: headLane,
                color: headColor,
                through: [],
                merges: [],
                forks: [],
                hasTop: false,
                hasBottom: true,
                width: headLane,
              }}
              colors={data.colors}
              wip
            />
          </div>
          <div className={s.strip} style={{ background: "transparent" }} />
          <div className={s.msg}>
            {/* Where the subject would sit once this is a commit - so the row
                reads as the commit it is about to become. Typing here and
                pressing Enter commits what is staged. */}
            <QuickCommit staged={staged} onCommit={onQuickCommit} />
            <span className={s.wipCounts}>
              {modified > 0 && <span className={s.wipMod}>&#9998; {modified}</span>}
              {added > 0 && <span className={s.wipAdd}>+ {added}</span>}
            </span>
          </div>
        </div>,
      );
      continue;
    }

    const c: Commit = data.commits[ci];
    let row = data.rows[ci];
    if (!c || !row) continue;
    // The synthetic WIP node sits above row 0, so row 0 must draw a line up
    // to meet it or the lane appears to break.
    if (hasWip && ci === 0 && !row.hasTop) row = { ...row, hasTop: true };

    rows.push(
      <div
        key={c.hash}
        className={[
          s.row,
          selectedSet.has(c.hash) ? s.sel : "",
          c.parents.length > 1 ? s.merge : "",
          c.hash === data.head.hash ? s.headRow : "",
        ].join(" ")}
        style={{ top: i * ROW_H }}
        onClick={(e) => onSelect(c.hash, e.ctrlKey || e.metaKey, e.shiftKey)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContext(c.hash, e.clientX, e.clientY);
        }}
      >
        <RefCell
          width={chipsWidth}
          labels={c.refs}
          headBranch={data.head.branch}
          menuOpen={menuOpen}
          onContext={onRefContext}
          onCheckout={onRefCheckout}
        />
        <div className={s.graphCell} style={{ width: graphWidth }}>
          {/* Band from this commit's dot across to the strip. Sits behind the
              lane lines, so it reads as a background rather than a bar. */}
          <div
            className={s.tint}
            style={{
              left: laneX(row.lane),
              background: tintOf(row.color, selectedSet.has(c.hash)),
            }}
          />
          <RowGraph row={row} colors={data.colors} merge={c.parents.length > 1} />
        </div>
        {/* Positioned on the row rather than inside the graph cell: the cell
            clips its overflow to keep lanes tidy, and the expanded stack needs
            to reach across the coloured band. */}
        {c.parents.length <= 1 && (
          <CommitNode
            x={laneX(row.lane)}
            color={data.colors[row.color % data.colors.length]}
            author={c.author}
            email={c.email}
            coAuthors={c.coAuthors ?? []}
            chipsWidth={chipsWidth}
            bandWidth={graphWidth - laneX(row.lane) + NODE_R + 1}
          />
        )}
        {/* The 2px lane-coloured strip the band runs into. */}
        <div
          className={s.strip}
          style={{ background: data.colors[row.color % data.colors.length] }}
        />
        <div className={s.msg}>
          <span className={s.subject}>{c.subject}</span>
          {c.body && <span className={s.body}>{c.body.split("\n")[0]}</span>}
          {markers.has(ci) && <span className={s.when}>{markers.get(ci)}</span>}
        </div>
      </div>,
    );
  }

  return (
    <div className={s.wrap}>
      <div className={s.colhead}>
        <div className={s.chOne} style={{ width: chipsWidth }}>
          BRANCH / TAG
        </div>
        <div className={s.chTwo} style={{ width: graphWidth }}>
          GRAPH
        </div>
        <div className={s.chThree}>COMMIT MESSAGE</div>
      </div>
      <div className={s.scroll} ref={scroller} onScroll={onScroll}>
        <div className={s.inner} style={{ height: total * ROW_H }}>
          {rows}
        </div>
      </div>
      <div
        className={s.resizer}
        style={{ left: chipsWidth }}
        onMouseDown={startChipsResize}
        onDoubleClick={() => {
          setChipsWidth(CHIPS_W_DEFAULT);
          localStorage.setItem(CHIPS_W_KEY, String(CHIPS_W_DEFAULT));
        }}
        title="Drag to resize the branch column — double-click to reset"
      />
      <div
        className={s.resizer}
        style={{ left: chipsWidth + graphWidth }}
        onMouseDown={startResize}
        onDoubleClick={fitWidth}
        title={
          userWidth === null
            ? `Auto-sized to the rows on screen (${Math.round((naturalWidth - PAD_X * 2) / LANE_W)} lanes deepest). Drag to pin a width.`
            : "Manual width — double-click to return to automatic"
        }
      />
    </div>
  );
}
