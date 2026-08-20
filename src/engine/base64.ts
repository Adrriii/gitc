// Decoding base64 to bytes.
//
// Written out by hand rather than reached for from the runtime: the byte
// conversions available here do not honour their encodings (see engine/json.ts
// for the same lesson learned the hard way), and the installer writes real
// binary files - a .ico Windows must be able to read, PNGs the icon theme
// must be able to load. Arithmetic over ASCII cannot be misinterpreted.
//
// The input is always a literal from src/generated/icons.ts, so it is genuine
// text and charCodeAt behaves.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reverse lookup, built once. -1 for anything that is not a base64 digit. */
const VALUES = buildValues();

function buildValues(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 128; i++) table.push(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
}

function valueOf(code: number): number {
  if (code < 0) return -1;
  if (code > 127) return -1;
  return VALUES[code];
}

/** Decodes base64 text into the bytes it stands for. */
export function fromBase64(text: string): Uint8Array {
  // Four characters carry three bytes; padding trims one or two off the end.
  let padding = 0;
  if (text.length > 0) {
    if (text.charAt(text.length - 1) === "=") padding += 1;
    if (text.length > 1) {
      if (text.charAt(text.length - 2) === "=") padding += 1;
    }
  }
  const groups = Math.floor(text.length / 4);
  const out = new Uint8Array(groups * 3 - padding);

  let o = 0;
  let i = 0;
  while (i + 3 < text.length) {
    const a = valueOf(text.charCodeAt(i));
    const b = valueOf(text.charCodeAt(i + 1));
    const c = valueOf(text.charCodeAt(i + 2));
    const d = valueOf(text.charCodeAt(i + 3));
    i += 4;

    // A negative value means padding or stray whitespace; treat it as zero
    // bits, which the padding arithmetic above has already accounted for.
    const av = a < 0 ? 0 : a;
    const bv = b < 0 ? 0 : b;
    const cv = c < 0 ? 0 : c;
    const dv = d < 0 ? 0 : d;

    const triple = (av << 18) | (bv << 12) | (cv << 6) | dv;

    if (o < out.length) out[o] = (triple >> 16) & 0xff;
    o += 1;
    if (o < out.length) out[o] = (triple >> 8) & 0xff;
    o += 1;
    if (o < out.length) out[o] = triple & 0xff;
    o += 1;
  }

  return out;
}
