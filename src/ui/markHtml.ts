import type { Span } from "./wordDiff";

/**
 * Wraps character ranges of a syntax-highlighted line.
 *
 * The line has already been through highlight.js, so it is markup: nested
 * `<span class="hljs-…">` around escaped text. The spans to mark were
 * computed against the PLAIN text, and the two do not line up - the markup
 * carries tags that occupy no text position, and entities that occupy five
 * characters of HTML for one of text.
 *
 * So this walks the HTML counting text positions only, and emits the mark
 * around the right characters. A mark that would straddle a tag is closed
 * before it and reopened after, which keeps the nesting valid whatever the
 * highlighter produced - overlapping `<mark>` and `<span>` would not be.
 *
 * The alternative was to give the marks their own absolutely-positioned
 * layer, which is simpler until a line wraps: `ch` offsets stop matching
 * anything the moment the text moves onto a second row, and wrapping is on by
 * default.
 */
export function markHtml(html: string, spans: Span[], className: string): string {
  if (spans.length === 0) return html;

  const open = '<mark class="' + className + '">';
  const close = "</mark>";

  let out = "";
  let text = 0;
  let i = 0;
  let inMark = false;
  let next = 0;

  /** Whether a text position falls inside a span, advancing the cursor. */
  const inside = (pos: number): boolean => {
    while (next < spans.length && spans[next].end <= pos) next += 1;
    return next < spans.length && pos >= spans[next].start;
  };

  while (i < html.length) {
    const c = html.charAt(i);

    if (c === "<") {
      // Tags hold no text. Step outside the mark for the duration of one, so
      // the mark never encloses half an element.
      const end = html.indexOf(">", i);
      const tag = end === -1 ? html.substring(i) : html.substring(i, end + 1);
      if (inMark) {
        out += close;
        inMark = false;
      }
      out += tag;
      i += tag.length;
      continue;
    }

    // One character of text, however many characters of HTML it takes.
    let piece = c;
    if (c === "&") {
      const semi = html.indexOf(";", i);
      // A bare ampersand is not an entity; anything absurdly long is not one
      // either, and treating it as one would lose the rest of the line.
      if (semi !== -1 && semi - i <= 10) piece = html.substring(i, semi + 1);
    }

    const want = inside(text);
    if (want && !inMark) {
      out += open;
      inMark = true;
    } else if (!want && inMark) {
      out += close;
      inMark = false;
    }

    out += piece;
    i += piece.length;
    text += 1;
  }

  if (inMark) out += close;
  return out;
}
