import { useCallback, useEffect, useState } from "react";

/**
 * Theming.
 *
 * Every colour in gitc already resolves to a CSS custom property - no component
 * carries a literal - so a theme is just a different set of values for those
 * properties, written onto the document at runtime. Nothing has to be rebuilt
 * and no component knows a theme exists.
 *
 * A theme is a preset plus whatever the user has overridden on top of it, kept
 * separately so changing preset does not silently discard their edits, and so
 * "reset this colour" means something.
 */

export interface TokenSpec {
  /** The custom property, without the leading dashes. */
  name: string;
  label: string;
}

export interface TokenGroup {
  title: string;
  blurb: string;
  tokens: TokenSpec[];
}

/**
 * Every themable colour, grouped the way someone editing them would think.
 *
 * The order here is the order they appear in Preferences, so it runs from the
 * surfaces you see everywhere down to the details.
 */
export const TOKEN_GROUPS: TokenGroup[] = [
  {
    title: "Surfaces",
    blurb: "Backgrounds, from the app floor up. Every panel sits on one of these.",
    tokens: [
      { name: "bg-0", label: "Floor" },
      { name: "bg-1", label: "Chrome" },
      { name: "bg-2", label: "Raised" },
      { name: "bg-3", label: "Hover" },
      { name: "bg-4", label: "Active" },
      { name: "bg-inset", label: "Inset" },
    ],
  },
  {
    title: "Lines",
    blurb: "Separators. The hairline does most of the work.",
    tokens: [
      { name: "line", label: "Hairline" },
      { name: "line-strong", label: "Divider" },
      { name: "line-hard", label: "Outer edge" },
    ],
  },
  {
    title: "Text",
    blurb: "From the brightest heading to the faintest hint.",
    tokens: [
      { name: "fg-bright", label: "Bright" },
      { name: "fg", label: "Normal" },
      { name: "fg-dim", label: "Dim" },
      { name: "fg-muted", label: "Muted" },
      { name: "fg-faint", label: "Faint" },
    ],
  },
  {
    title: "Accent",
    blurb: "Selection, focus, and the active tab.",
    tokens: [
      { name: "accent", label: "Accent" },
      { name: "accent-hover", label: "Accent hover" },
      { name: "accent-line", label: "Accent line" },
      { name: "accent-bg", label: "Accent surface" },
      { name: "accent-fg", label: "On accent" },
      { name: "chip-head", label: "Checked-out chip" },
      { name: "chip-head-fg", label: "On that chip" },
    ],
  },
  {
    title: "Status",
    blurb: "Additions, deletions and warnings, in the diff and everywhere else.",
    tokens: [
      { name: "green", label: "Added" },
      { name: "green-bg", label: "Added surface" },
      { name: "green-line", label: "Added line" },
      { name: "green-fg", label: "Added text" },
      { name: "red", label: "Removed" },
      { name: "red-bg", label: "Removed surface" },
      { name: "red-line", label: "Removed line" },
      { name: "red-fg", label: "Removed text" },
      { name: "amber", label: "Warning" },
      { name: "amber-bg", label: "Warning surface" },
      { name: "amber-fg", label: "Warning text" },
      { name: "purple", label: "Purple" },
      { name: "cyan", label: "Cyan" },
    ],
  },
  {
    title: "Syntax",
    blurb: "Code colouring in diffs and the conflict editor.",
    tokens: [
      { name: "syn-keyword", label: "Keyword" },
      { name: "syn-type", label: "Type" },
      { name: "syn-number", label: "Number" },
      { name: "syn-string", label: "String" },
      { name: "syn-regexp", label: "Regexp" },
      { name: "syn-title", label: "Function" },
      { name: "syn-variable", label: "Variable" },
      { name: "syn-comment", label: "Comment" },
      { name: "syn-doctag", label: "Doc tag" },
      { name: "syn-meta", label: "Meta" },
      { name: "syn-tag", label: "Tag" },
      { name: "syn-punct", label: "Punctuation" },
    ],
  },
  {
    title: "Graph lanes",
    blurb: "Assigned to branches in order. They need to stay apart from each other.",
    tokens: [
      // Not "Lane 1": the graph keeps this one for master/main and gives it
      // to nothing else (see TRUNK_COLOR), so the label should say so rather
      // than suggest it is the first of nine interchangeable slots.
      { name: "lane-0", label: "master / main" },
      { name: "lane-1", label: "Lane 1" },
      { name: "lane-2", label: "Lane 2" },
      { name: "lane-3", label: "Lane 3" },
      { name: "lane-4", label: "Lane 4" },
      { name: "lane-5", label: "Lane 5" },
      { name: "lane-6", label: "Lane 6" },
      { name: "lane-7", label: "Lane 7" },
      { name: "lane-8", label: "Lane 8" },
      // Not one of the lanes: stashes are drawn in this and nothing else is.
      { name: "stash", label: "Stash" },
    ],
  },
];

export const ALL_TOKENS: string[] = TOKEN_GROUPS.flatMap((g) => g.tokens.map((t) => t.name));

export type Palette = Record<string, string>;

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  /** True when the palette is light, so the picker can group them. */
  light?: boolean;
  colors: Palette;
}

/** The palette gitc ships with: dense, editor-native, near-black. */
const MIDNIGHT: Palette = {
  "bg-0": "#0f1115",
  "bg-1": "#131519",
  "bg-2": "#171a20",
  "bg-3": "#1c2027",
  "bg-4": "#22262e",
  "bg-inset": "#0b0d10",
  line: "#1e2127",
  "line-strong": "#2a2e36",
  "line-hard": "#08090b",
  fg: "#c9ccd1",
  "fg-bright": "#eceef1",
  "fg-dim": "#9aa0a8",
  "fg-muted": "#6f757e",
  "fg-faint": "#545a63",
  accent: "#4f8cff",
  "accent-hover": "#6b9dff",
  "accent-line": "#2f5fb0",
  "accent-bg": "#16263f",
  "accent-fg": "#d5e3ff",
  green: "#3fb950",
  "green-bg": "#10261a",
  "green-line": "#2a5c34",
  "green-fg": "#7ee787",
  red: "#f85149",
  "red-bg": "#2b1416",
  "red-line": "#6e2b28",
  "red-fg": "#ff9d97",
  amber: "#d29922",
  "amber-bg": "#2a2013",
  "amber-fg": "#e3b341",
  purple: "#a371f7",
  cyan: "#39c5cf",
  "chip-head": "#16324f",
  "chip-head-fg": "#cfe3ff",
  "lane-0": "#4f8cff",
  "lane-1": "#3fb950",
  "lane-2": "#d29922",
  "lane-3": "#a371f7",
  "lane-4": "#39c5cf",
  "lane-5": "#f85149",
  "lane-6": "#db61a2",
  "lane-7": "#7ee787",
  "lane-8": "#ff9d5c",
  stash: "#8b93a1",
  "syn-keyword": "#569cd6",
  "syn-type": "#4ec9b0",
  "syn-number": "#b5cea8",
  "syn-string": "#ce9178",
  "syn-regexp": "#d16969",
  "syn-title": "#dcdcaa",
  "syn-variable": "#9cdcfe",
  "syn-comment": "#6a9955",
  "syn-doctag": "#608b4e",
  "syn-meta": "#c586c0",
  "syn-tag": "#808080",
  "syn-punct": "#d7ba7d",
};

/** Warm neutral greys with a teal accent - quieter than Midnight. */
const GRAPHITE: Palette = {
  ...MIDNIGHT,
  "bg-0": "#17181a",
  "bg-1": "#1c1d20",
  "bg-2": "#212327",
  "bg-3": "#282a2f",
  "bg-4": "#303339",
  "bg-inset": "#121315",
  line: "#26282d",
  "line-strong": "#34373e",
  "line-hard": "#0e0f11",
  fg: "#d2d2d4",
  "fg-bright": "#f1f1f3",
  "fg-dim": "#a4a5a9",
  "fg-muted": "#77797e",
  "fg-faint": "#5c5e63",
  accent: "#4db6ac",
  "accent-hover": "#66c9c0",
  "accent-line": "#2f6d66",
  "accent-bg": "#16302e",
  "accent-fg": "#d6f2ee",
  "chip-head": "#1b3f3b",
  "chip-head-fg": "#cdeeea",
  "lane-0": "#4db6ac",
  "lane-1": "#7cb342",
  "lane-2": "#c9a227",
  "lane-3": "#9575cd",
  "lane-4": "#4fc3f7",
  "lane-5": "#e57373",
  "lane-6": "#ba68c8",
  "lane-7": "#aed581",
  "lane-8": "#ffb74d",
  stash: "#8d9296",
};

/** Warm and low-contrast, with amber where Midnight is blue. */
const EMBER: Palette = {
  ...MIDNIGHT,
  "bg-0": "#15120f",
  "bg-1": "#1a1613",
  "bg-2": "#201b17",
  "bg-3": "#27211c",
  "bg-4": "#2f2822",
  "bg-inset": "#100d0b",
  line: "#26201b",
  "line-strong": "#372f27",
  "line-hard": "#0b0908",
  fg: "#d6cec4",
  "fg-bright": "#f4efe8",
  "fg-dim": "#a89f93",
  "fg-muted": "#7c7368",
  "fg-faint": "#605850",
  accent: "#e08c3c",
  "accent-hover": "#f0a055",
  "accent-line": "#8a5620",
  "accent-bg": "#33220f",
  "accent-fg": "#ffe6c9",
  "chip-head": "#3a2510",
  "chip-head-fg": "#ffdfb8",
  green: "#8bbf5a",
  "green-bg": "#1b2412",
  "green-line": "#456b2c",
  "green-fg": "#bfe093",
  red: "#e2604f",
  "red-bg": "#2c1512",
  "red-line": "#7a3227",
  "red-fg": "#f7a495",
  "lane-0": "#e08c3c",
  "lane-1": "#8bbf5a",
  "lane-2": "#d9b45c",
  "lane-3": "#b98ad6",
  "lane-4": "#5cb8c4",
  "lane-5": "#e2604f",
  "lane-6": "#d1729b",
  "lane-7": "#a8cf7e",
  "lane-8": "#f0a055",
  stash: "#9b8d7d",
};

/** A light palette. Every token is defined here, not inherited from a dark one. */
const DAYLIGHT: Palette = {
  "bg-0": "#ffffff",
  "bg-1": "#f6f7f9",
  "bg-2": "#eef0f3",
  "bg-3": "#e6e9ed",
  "bg-4": "#dbdfe5",
  "bg-inset": "#f0f2f5",
  line: "#dfe3e8",
  "line-strong": "#c6ccd4",
  "line-hard": "#b9c0c9",
  fg: "#24292f",
  "fg-bright": "#0b0f14",
  "fg-dim": "#4a5158",
  "fg-muted": "#6b737c",
  "fg-faint": "#8c949d",
  accent: "#0969da",
  "accent-hover": "#1f7ce8",
  "accent-line": "#8fbaf0",
  "accent-bg": "#ddeafc",
  "accent-fg": "#08305e",
  green: "#1a7f37",
  "green-bg": "#dcffe4",
  "green-line": "#95d3a5",
  "green-fg": "#116329",
  red: "#cf222e",
  "red-bg": "#ffebe9",
  "red-line": "#f0b3ae",
  "red-fg": "#a40e26",
  amber: "#9a6700",
  "amber-bg": "#fff8c5",
  "amber-fg": "#7a5200",
  purple: "#8250df",
  cyan: "#1b7c83",
  "chip-head": "#ddeafc",
  "chip-head-fg": "#08305e",
  "lane-0": "#0969da",
  "lane-1": "#1a7f37",
  "lane-2": "#9a6700",
  "lane-3": "#8250df",
  "lane-4": "#1b7c83",
  "lane-5": "#cf222e",
  "lane-6": "#bf3989",
  "lane-7": "#2da44e",
  "lane-8": "#bc4c00",
  stash: "#8e959d",
  "syn-keyword": "#cf222e",
  "syn-type": "#953800",
  "syn-number": "#0550ae",
  "syn-string": "#0a3069",
  "syn-regexp": "#116329",
  "syn-title": "#8250df",
  "syn-variable": "#953800",
  "syn-comment": "#6e7781",
  "syn-doctag": "#57606a",
  "syn-meta": "#8250df",
  "syn-tag": "#116329",
  "syn-punct": "#24292f",
};

export const PRESETS: Preset[] = [
  { id: "midnight", name: "Midnight", blurb: "The default: near-black and dense.", colors: MIDNIGHT },
  { id: "graphite", name: "Graphite", blurb: "Neutral greys, teal accent.", colors: GRAPHITE },
  { id: "ember", name: "Ember", blurb: "Warm, low contrast, amber accent.", colors: EMBER },
  { id: "daylight", name: "Daylight", blurb: "A light palette.", light: true, colors: DAYLIGHT },
];

const PRESET_KEY = "gitc.themePreset";
const OVERRIDE_KEY = "gitc.themeOverrides";
const CHANGED = "gitc:theme";

export function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

function readOverrides(): Palette {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as Palette;
    // Only tokens we know about: a stale key from an older build should not
    // end up painted onto the document.
    const kept: Palette = {};
    for (const name of ALL_TOKENS) {
      if (typeof parsed[name] === "string") kept[name] = parsed[name];
    }
    return kept;
  } catch {
    return {};
  }
}

/**
 * Paints a palette onto the document.
 *
 * Exported because the very first paint has to happen before React renders,
 * or the app flashes the default palette on every start.
 */
export function applyPalette(colors: Palette): void {
  const root = document.documentElement;
  for (const name of ALL_TOKENS) {
    const value = colors[name];
    if (value !== undefined) root.style.setProperty("--" + name, value);
  }
}

/** Reads the saved theme and paints it. Called once, before the first render. */
export function applySavedTheme(): void {
  const id = localStorage.getItem(PRESET_KEY) ?? PRESETS[0].id;
  applyPalette({ ...presetById(id).colors, ...readOverrides() });
}

export function useTheme() {
  const [presetId, setPresetId] = useState<string>(
    () => localStorage.getItem(PRESET_KEY) ?? PRESETS[0].id,
  );
  const [overrides, setOverrides] = useState<Palette>(readOverrides);

  const colors: Palette = { ...presetById(presetId).colors, ...overrides };

  useEffect(() => {
    applyPalette(colors);
  }, [presetId, overrides]);

  // Other components rendering theme swatches need to follow along.
  useEffect(() => {
    const sync = () => {
      setPresetId(localStorage.getItem(PRESET_KEY) ?? PRESETS[0].id);
      setOverrides(readOverrides());
    };
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);

  const choosePreset = useCallback((id: string) => {
    localStorage.setItem(PRESET_KEY, id);
    setPresetId(id);
    window.dispatchEvent(new Event(CHANGED));
  }, []);

  const setColor = useCallback((name: string, value: string) => {
    setOverrides((cur) => {
      const next = { ...cur, [name]: value };
      localStorage.setItem(OVERRIDE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /** Drops one override, or all of them, back to the preset's value. */
  const reset = useCallback((name?: string) => {
    setOverrides((cur) => {
      const next = name === undefined ? {} : { ...cur };
      if (name !== undefined) delete next[name];
      localStorage.setItem(OVERRIDE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { presetId, preset: presetById(presetId), colors, overrides, choosePreset, setColor, reset };
}
