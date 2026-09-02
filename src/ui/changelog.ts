// Just enough Markdown to render a release's own notes.
//
// The notes are written to a fixed shape (CHANGELOG_STYLE.md): a few `##`
// sections, bullets under them, and a link on every entry to the commits it
// came from. That is the whole grammar this needs to know, so it is the whole
// grammar it implements - a Markdown library would be an order of magnitude
// more code than the thing it renders.
//
// It parses to a structure rather than to HTML on purpose. The text arrives
// over the network from a release page, and the one thing that must not
// happen is a network response reaching the DOM as markup. Pieces become
// React elements, so there is nothing to escape and nothing to get wrong.

export interface Piece {
  text: string;
  /** Set when the piece is a link. Always https - see linkable(). */
  href?: string;
  code?: boolean;
  bold?: boolean;
}

export interface Line {
  kind: "heading" | "bullet" | "text" | "blank";
  /** Heading level, or bullet indent depth. */
  depth: number;
  pieces: Piece[];
}

/**
 * Whether a link target may be rendered as a link.
 *
 * The notes come from a release page, and a link is the one piece of this
 * that would carry a URL into the window. https only: no javascript:, no
 * data:, no relative path that would resolve against the engine's own origin.
 */
function linkable(url: string): boolean {
  return url.startsWith("https://");
}

/** Splits one line into its links, code spans and bold runs. */
export function inlines(text: string): Piece[] {
  const out: Piece[] = [];
  let plain = "";

  const flush = () => {
    if (plain.length > 0) out.push({ text: plain });
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.substring(i);

    // [label](https://…)
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null) {
      flush();
      const url = link[2];
      if (linkable(url)) out.push({ text: link[1], href: url });
      else out.push({ text: link[1] });
      i += link[0].length;
      continue;
    }

    // `code`
    const code = /^`([^`]+)`/.exec(rest);
    if (code !== null) {
      flush();
      out.push({ text: code[1], code: true });
      i += code[0].length;
      continue;
    }

    // **bold**
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold !== null) {
      flush();
      out.push({ text: bold[1], bold: true });
      i += bold[0].length;
      continue;
    }

    plain += text.charAt(i);
    i += 1;
  }

  flush();
  return out;
}

/**
 * The changelog out of a release body, without the rest of the release.
 *
 * A published release does not open with its notes. The workflow puts the
 * download instructions first - which system takes which file, what has to be
 * on PATH - and a Full Changelog link after them, and only then does
 * release.mjs's text begin. None of that is what changed in the version, and
 * somebody reading the About tab has it installed already.
 *
 * The notes proper start at the first `##` section. GitHub's own
 * "What's Changed" list, where it appears, comes after them - a list of commit
 * titles, which is precisely the thing written notes exist to replace.
 *
 * A release with no sections at all has no changelog to show, and says so
 * rather than falling back to the install instructions.
 */
export function changelogOnly(markdown: string): string {
  const lines = markdown.replace(/\r/g, "").split("\n");

  const start = lines.findIndex((l) => /^##\s+\S/.test(l));
  if (start === -1) return "";

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^##+\s+What.s Changed/i.test(line) || /^\*\*Full Changelog\*\*/.test(line)) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trim();
}

/** Turns a release body into lines the About tab can lay out. */
export function parseNotes(markdown: string): Line[] {
  const out: Line[] = [];

  for (const raw of markdown.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      out.push({ kind: "blank", depth: 0, pieces: [] });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      out.push({ kind: "heading", depth: heading[1].length, pieces: inlines(heading[2]) });
      continue;
    }

    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      // Two spaces to a level, which is what the notes are written with.
      out.push({
        kind: "bullet",
        depth: Math.floor(bullet[1].length / 2),
        pieces: inlines(bullet[2]),
      });
      continue;
    }

    // An indented line under a bullet is the same bullet, wrapped. The notes
    // are written hard-wrapped at about 76 columns, so nearly every entry is
    // two or three lines - and treating each as its own paragraph put the rest
    // of the sentence, and the commit link at the end of it, flush against the
    // left edge under the dash rather than in the entry it belongs to.
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (/^\s+\S/.test(line) && last !== undefined && last.kind === "bullet") {
      last.pieces = last.pieces.concat(inlines(" " + line.trim()));
      continue;
    }

    out.push({ kind: "text", depth: 0, pieces: inlines(line.trim()) });
  }

  // A trailing blank line would draw a gap under the last entry.
  while (out.length > 0 && out[out.length - 1].kind === "blank") out.pop();
  return out;
}
