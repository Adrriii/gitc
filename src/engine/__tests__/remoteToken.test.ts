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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
