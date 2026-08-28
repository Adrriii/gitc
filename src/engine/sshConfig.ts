// Reading ~/.ssh/config, for the list of hosts a remote tab can be opened on.
//
// gitc parses this to *offer* hosts, not to resolve them. Connecting runs
// `ssh <alias>` and lets OpenSSH apply the file itself - which is the only way
// to be right about Match blocks, canonicalisation, token expansion, the
// system config in /etc/ssh/ssh_config and the dozens of keywords gitc has no
// opinion about. Reimplementing that here would be a second, worse ssh.
//
// So the job is narrow: find the aliases a person could sensibly pick, and
// enough of HostName/User/Port to label them in a list.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, dirname } from "node:path";

import { at } from "./safe.ts";

export interface SshHost {
  /** The name as written after `Host`, and the argument ssh gets. */
  alias: string;
  /** For the label under the alias; null when the config does not say. */
  hostName: string | null;
  user: string | null;
  port: number | null;
}

export interface SshConfig {
  hosts: SshHost[];
  /** Unexpanded `Include` arguments, in the order they appeared. */
  includes: string[];
}

/**
 * True for a pattern that names one host rather than matching a family of
 * them. `Host *`, `Host *.internal` and `Host !build` configure other entries;
 * they are not somewhere you can connect, so they never reach the list.
 */
function isLiteral(pattern: string): boolean {
  return (
    pattern.length > 0 &&
    !pattern.includes("*") &&
    !pattern.includes("?") &&
    !pattern.startsWith("!")
  );
}

/** Strips one layer of surrounding quotes, which ssh_config allows. */
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.substring(1, v.length - 1);
  }
  return v;
}

/**
 * Splits `Keyword value` or `Keyword=value` into a lowercased keyword and the
 * rest of the line. ssh accepts either separator, and whitespace around `=`.
 */
function split(line: string): { key: string; rest: string } | null {
  const eq = line.indexOf("=");
  const sp = line.search(/\s/);
  // Whichever separator comes first is the real one: `ProxyCommand ssh -W %h`
  // contains an `=` much later, and `Host=build` contains no space at all.
  let cut = -1;
  if (eq >= 0 && (sp < 0 || eq < sp)) cut = eq;
  else if (sp >= 0) cut = sp;
  if (cut < 0) return null;

  const key = line.substring(0, cut).toLowerCase();
  let rest = line.substring(cut + 1).trim();
  // `Host = build` - the separator was the space, so an `=` can still lead.
  if (rest.startsWith("=")) rest = rest.substring(1).trim();
  if (key.length === 0 || rest.length === 0) return null;
  return { key, rest };
}

/**
 * Parses the text of one ssh config file.
 *
 * ssh_config's rule is that the FIRST value obtained for a keyword wins, not
 * the last - the opposite of most config formats, and worth stating because
 * the natural implementation gets it backwards.
 */
export function parseSshConfig(text: string): SshConfig {
  const hosts: SshHost[] = [];
  const includes: string[] = [];
  // Which entries the keywords being read now belong to. A `Host` line with
  // several patterns configures all of them at once.
  let current: SshHost[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const parts = split(line);
    if (parts === null) continue;
    const { key, rest } = parts;

    if (key === "host") {
      current = [];
      for (const pattern of rest.split(/\s+/)) {
        const alias = unquote(pattern);
        if (!isLiteral(alias)) continue;
        // A repeated alias keeps the first block, since first value wins.
        const seen = hosts.find((h) => h.alias === alias);
        if (seen !== undefined) {
          current.push(seen);
          continue;
        }
        const host: SshHost = { alias, hostName: null, user: null, port: null };
        hosts.push(host);
        current.push(host);
      }
      continue;
    }

    // A Match block's keywords belong to whatever it matches, which is
    // decided at connect time and not here. Stop attributing them to the last
    // Host, rather than silently mislabelling it.
    if (key === "match") {
      current = [];
      continue;
    }

    if (key === "include") {
      for (const path of rest.split(/\s+/)) includes.push(unquote(path));
      continue;
    }

    if (current.length === 0) continue;
    const value = unquote(rest);

    for (const host of current) {
      if (key === "hostname" && host.hostName === null) host.hostName = value;
      if (key === "user" && host.user === null) host.user = value;
      if (key === "port" && host.port === null) {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n > 0) host.port = n;
      }
    }
  }

  return { hosts, includes };
}

/** Where ssh keeps the user's own config. */
export function sshConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}

/**
 * Every host offered by the user's config, following `Include`.
 *
 * Missing or unreadable files are not an error: no config means no remote
 * hosts to offer, which is a perfectly ordinary machine.
 */
export function readSshHosts(): SshHost[] {
  const out: SshHost[] = [];
  const seen: string[] = [];
  // Breadth of includes is bounded, because a config that includes itself
  // would otherwise not terminate.
  const queue: string[] = [sshConfigPath()];
  let guard = 0;

  while (queue.length > 0 && guard < 64) {
    guard++;
    const path = at(queue, 0);
    queue.shift();
    if (path === undefined || seen.includes(path)) continue;
    seen.push(path);
    if (!existsSync(path)) continue;

    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      // Unreadable is the same as absent for this purpose.
      continue;
    }

    const parsed = parseSshConfig(text);
    for (const host of parsed.hosts) {
      if (out.find((h) => h.alias === host.alias) === undefined) out.push(host);
    }
    for (const inc of parsed.includes) {
      // ssh resolves a relative Include against ~/.ssh, not the cwd.
      queue.push(isAbsolute(inc) ? inc : join(dirname(sshConfigPath()), inc));
    }
  }

  return out;
}
