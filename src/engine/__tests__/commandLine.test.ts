import { windowsCommandLine } from "../quirks.ts";

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

eq("plain", windowsCommandLine(["powershell", "-NoProfile"]), "powershell -NoProfile");
eq("empty", windowsCommandLine(["a", ""]), 'a ""');
eq("space", windowsCommandLine(["a b"]), '"a b"');
eq("backslash alone", windowsCommandLine(["C:\\x\\y"]), "C:\\x\\y");
eq("backslash with space", windowsCommandLine(["C:\\Program Files\\x"]), '"C:\\Program Files\\x"');
eq("quote", windowsCommandLine(['hello"world']), '"hello\\"world"');
eq("backslash before quote", windowsCommandLine(['hello\\"world']), '"hello\\\\\\"world"');
eq("trailing backslash", windowsCommandLine(["hello world\\"]), '"hello world\\\\"');
eq(
  "install script",
  windowsCommandLine(["-Command", "$d='C:\\Users\\A B\\gitc'; if ($p -notcontains $d) { 1 }"]),
  "-Command \"$d='C:\\Users\\A B\\gitc'; if ($p -notcontains $d) { 1 }\"",
);

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
process.exitCode = fail === 0 ? 0 : 1;
