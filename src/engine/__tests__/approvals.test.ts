import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

// Same trick as session.test: the store reads its directory from the
// environment, so the whole test runs against one of its own. APPDATA is
// checked first on every platform, so this works on Linux too - which matters,
// because npm test runs inside the release build's ubuntu leg.
const home = mkdtempSync(join(tmpdir(), "gitc-approvals-test-"));
mkdirSync(join(home, "gitc"), { recursive: true });
process.env["APPDATA"] = home;

const { isApprovedRemote, approvedRemotes, approveRemote, revokeRemote } = await import(
  "../approvals.ts"
);
const { planRemote } = await import("../remote.ts");

eq("nothing is approved to begin with", approvedRemotes(), []);
eq("an unknown machine is not approved", isApprovedRemote("server"), false);

approveRemote("server");
eq("approving records the machine", approvedRemotes(), ["server"]);
eq("and it reads back as approved", isApprovedRemote("server"), true);

// Written to disk rather than held in memory: the point of remembering is
// that the next launch does not ask again.
const reread = await import("../approvals.ts?reload");
eq("the approval is on disk", reread.approvedRemotes(), ["server"]);

approveRemote("server");
eq("approving twice records it once", approvedRemotes(), ["server"]);

// Matched exactly. Two spellings may well be one machine, but deciding that
// means resolving ~/.ssh/config, which the engine never does - and one extra
// prompt is a far smaller surprise than installing somewhere nobody named.
eq("another spelling of the same host is its own decision", isApprovedRemote("adri@server"), false);

approveRemote("adri@server");
eq("both are kept, in the order agreed to", approvedRemotes(), ["server", "adri@server"]);

revokeRemote("server");
eq("revoking removes just that one", approvedRemotes(), ["adri@server"]);
eq("and it is asked about again", isApprovedRemote("server"), false);

revokeRemote("never-approved");
eq("revoking something unknown changes nothing", approvedRemotes(), ["adri@server"]);

// A file nobody can read means nothing is approved. Failing the other way
// would install on a machine on the strength of a truncated file, which is
// the one outcome this store exists to prevent.
writeFileSync(join(home, "gitc", "remotes.json"), "{ this is not json", "utf8");
const broken = await import("../approvals.ts?broken");
eq("a damaged file approves nothing", broken.approvedRemotes(), []);
eq("and refuses rather than assumes", broken.isApprovedRemote("adri@server"), false);

// planRemote is what the window asks BEFORE anything is installed, so it has
// to answer for a destination ssh would read as an option without running ssh
// to find out.
const plan = await planRemote("-oProxyCommand=touch /tmp/pwned");
eq("an option-shaped destination is refused, unasked", plan.action, "refused");
eq("nothing is claimed to be installed there", plan.have, null);

rmSync(home, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
