// Which machines gitc has been allowed to keep a copy of itself on.
//
// A remote tab is a whole gitc engine running over there, so opening one means
// writing a binary into somebody else's home directory over ssh. That used to
// happen on the first keystroke of a directory listing: picking a host out of
// ~/.ssh/config was enough to install software on it, with nothing said and
// nothing asked. Browsing a machine is not the same act as installing on it.
//
// So the first install on a host is asked for, and the answer is kept here.
// Per host rather than per version: what is being agreed to is "gitc may keep
// a copy of itself on this machine", and the upgrade that follows a gitc
// update is that copy staying usable - the two engines must be the same
// version to talk at all, so a prompt there would have exactly one sensible
// answer, which is not a question worth asking.
//
// Nothing here grants access to the machine; ssh already does that. It only
// records that gitc may put a file on it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface ApprovalFile {
  /** ssh destinations, spelled exactly as they were connected to. */
  hosts: string[];
}

// The same directory as session.json and hidden.json, and the same three-line
// spelling of it. Kept local rather than shared: each of these files is
// standalone, and a module that only exists to hold this function would be
// read by more places than it saves.
function configDir(): string {
  const appData = process.env["APPDATA"];
  if (appData !== undefined && appData.length > 0) return join(appData, "gitc");
  const home = process.env["HOME"];
  if (home !== undefined && home.length > 0) return join(home, ".config", "gitc");
  return ".gitc";
}

function filePath(): string {
  return join(configDir(), "remotes.json");
}

function loadAll(): ApprovalFile {
  const path = filePath();
  if (!existsSync(path)) return { hosts: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ApprovalFile;
    return { hosts: parsed.hosts };
  } catch {
    // An unreadable file means nothing is approved, which costs a prompt.
    // Failing open here would install on a machine on the strength of a
    // truncated file, which is the one outcome this module exists to prevent.
    return { hosts: [] };
  }
}

/** The machines gitc may install itself on, in the order they were approved. */
export function approvedRemotes(): string[] {
  return loadAll().hosts;
}

/**
 * Whether this destination has been approved.
 *
 * Matched exactly. "server" and "adri@server" may well be the same machine,
 * but deciding that means resolving ~/.ssh/config, which this engine
 * deliberately never does - and being asked twice for two spellings is a far
 * smaller surprise than installing on a machine nobody named.
 */
export function isApprovedRemote(host: string): boolean {
  for (const entry of approvedRemotes()) {
    if (entry === host) return true;
  }
  return false;
}

/** Records that gitc may install itself on this machine. */
export function approveRemote(host: string): void {
  if (host.length === 0 || isApprovedRemote(host)) return;
  const hosts = approvedRemotes();
  hosts.push(host);
  save(hosts);
}

/** Takes the approval back. The binary already over there is left alone. */
export function revokeRemote(host: string): void {
  const kept: string[] = [];
  for (const entry of approvedRemotes()) {
    if (entry !== host) kept.push(entry);
  }
  save(kept);
}

function save(hosts: string[]): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath(), JSON.stringify({ hosts }), "utf8");
}
