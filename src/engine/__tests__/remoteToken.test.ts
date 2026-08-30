import { readToken, withoutToken, TOKEN_LINE } from "../remote.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "  ok  " : " FAIL "} ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`,
  );
}

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const TOKEN = "9f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f";

// What a remote engine actually prints, in the order it prints it.
const said = [
  "gitc serving http://127.0.0.1:7893/",
  "engine only, no window",
  TOKEN_LINE + " " + TOKEN,
  "",
].join(LF);

eq("the token", readToken(said), TOKEN);

// -tt allocates a pty, so lines come back CR LF and the CR belongs to
// neither the token nor the next line.
eq("through a pty", readToken(said.split(LF).join(CRLF)), TOKEN);

// A pty delivers in whatever chunks it likes. A line still arriving is not a
// token yet - half a secret would fail every request with no way to recover.
eq("a partial line", readToken(TOKEN_LINE + " 9f2c1d4e"), null);
eq("nothing yet", readToken(""), null);
eq("said other things only", readToken("gitc serving http://127.0.0.1:7893/" + LF), null);
eq("the prefix with no value", readToken(TOKEN_LINE + " " + LF), null);

// The same text becomes an error message in the UI, and a secret in a
// message is a secret in a screenshot and in a bug report.
eq(
  "stripped for messages",
  withoutToken(said),
  ["gitc serving http://127.0.0.1:7893/", "engine only, no window", ""].join(LF),
);
eq("stripped text holds no token", withoutToken(said).includes(TOKEN), false);
eq("nothing to strip", withoutToken("port 7893 is already in use"), "port 7893 is already in use");

// A pty carries the host's banner and MOTD before anything gitc says, and a
// long one used to push the token out of the 4000-character buffer the scan
// read from - making that host permanently unconnectable, and reporting it as
// a timeout rather than as the cause. The scan runs over a sliding tail of
// its own now, so these are the cases that have to keep working.
const TAIL = 4096;
const tail = (text: string) => (text.length > TAIL ? text.substring(text.length - TAIL) : text);
const banner = "x".repeat(9000) + LF;

eq("behind a 9000-character banner", readToken(tail(banner + TOKEN_LINE + " " + TOKEN + LF)), TOKEN);

// And the line split across chunk boundaries, which a pty does freely.
let acc = "";
for (const chunk of [banner, TOKEN_LINE + " " + TOKEN.substring(0, 10), TOKEN.substring(10) + LF]) {
  acc = tail(acc + chunk);
}
eq("split across chunks", readToken(acc), TOKEN);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
