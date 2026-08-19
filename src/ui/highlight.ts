import hljs from "highlight.js";

/**
 * Syntax highlighting for the diff viewer.
 *
 * Two things make this harder than calling a highlighter:
 *
 * 1. Highlighting must span lines. A block comment or a template literal that
 *    opens on one line and closes three lines later only tokenises correctly
 *    if the highlighter sees the whole run at once. So we highlight a hunk's
 *    text as one string and then split the resulting HTML per line, reopening
 *    any spans that were still open at the line break.
 *
 * 2. A diff has two texts, not one. The old side (context + deletions) and
 *    the new side (context + additions) are each valid source; interleaving
 *    them is not, and would produce garbage tokens around every edit. They
 *    are highlighted separately and mapped back onto the rows.
 *
 * The full highlight.js language set is bundled - gitc ships as one binary
 * with no network, so there is nothing to lazy-load from.
 */

/** Extensions whose language name isn't already an highlight.js alias. */
const EXTRA: Record<string, string> = {
  tsx: "typescript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  vue: "xml",
  svelte: "xml",
  htm: "xml",
  html: "xml",
  xaml: "xml",
  csproj: "xml",
  props: "xml",
  targets: "xml",
  resx: "xml",
  plist: "xml",
  svg: "xml",
  h: "c",
  hpp: "cpp",
  hh: "cpp",
  cc: "cpp",
  cxx: "cpp",
  ipynb: "json",
  jsonc: "json",
  json5: "json",
  babelrc: "json",
  eslintrc: "json",
  gradle: "groovy",
  psm1: "powershell",
  psd1: "powershell",
  zsh: "bash",
  fish: "bash",
  bashrc: "bash",
  cmd: "dos",
  bat: "dos",
  mdx: "markdown",
  rst: "markdown",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "terraform",
  cshtml: "xml",
  razor: "xml",
  sass: "scss",
  styl: "stylus",
  pyi: "python",
  ipy: "python",
  rake: "ruby",
  gemspec: "ruby",
  podspec: "ruby",
  cl: "c",
  metal: "cpp",
  glsl: "glsl",
  vert: "glsl",
  frag: "glsl",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  editorconfig: "ini",
  gitconfig: "ini",
  env: "bash",
};

/** Filenames with no useful extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  cmakelists: "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  vagrantfile: "ruby",
  brewfile: "ruby",
  gitignore: "properties",
  gitattributes: "properties",
  npmrc: "ini",
  nvmrc: "properties",
};

/** Resolves a highlight.js language name for a path, or null to leave plain. */
export function languageFor(path: string): string | null {
  const file = path.substring(path.lastIndexOf("/") + 1);
  const lower = file.toLowerCase();

  const byName = BY_NAME[lower.replace(/^\./, "")];
  if (byName !== undefined) return byName;

  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = lower.substring(dot + 1);

  const extra = EXTRA[ext];
  if (extra !== undefined && hljs.getLanguage(extra)) return extra;

  // Most extensions are already registered aliases (ts, py, rb, cs, go, rs…).
  if (hljs.getLanguage(ext)) return ext;
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Highlights `code` and returns one HTML string per line.
 *
 * The walk keeps a stack of the spans currently open. At every newline it
 * closes them, emits the line, and reopens them on the next - which is what
 * keeps a multi-line construct correctly coloured on each of its lines.
 */
export function highlightLines(code: string, language: string): string[] {
  let html: string;
  try {
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return code.split("\n").map(escapeHtml);
  }

  const holder = document.createElement("div");
  holder.innerHTML = html;

  const lines: string[] = [];
  const open: string[] = [];
  let current = "";

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.nodeValue ?? "").split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          current += "</span>".repeat(open.length);
          lines.push(current);
          current = open.map((c) => `<span class="${c}">`).join("");
        }
        current += escapeHtml(parts[i]);
      }
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const cls = el.className;
      open.push(cls);
      current += `<span class="${cls}">`;
      el.childNodes.forEach(walk);
      current += "</span>";
      open.pop();
      return;
    }
  };

  holder.childNodes.forEach(walk);
  lines.push(current);
  return lines;
}

/** Above this, highlighting costs more than it's worth on a scroll. */
export const MAX_HIGHLIGHT_CHARS = 2 * 1024 * 1024;
