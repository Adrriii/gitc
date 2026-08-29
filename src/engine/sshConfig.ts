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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, dirname, basename } from "node:path";

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

/**
 * The files an Include argument names, expanding a wildcard in its last part.
 *
 * `Include ~/.ssh/config.d/*` is the standard idiom - it is what 1Password and
 * most managed configs write - and treating it as a literal filename found
 * nothing, silently. A user whose hosts all live behind one of those saw an
 * empty list and no reason, and the whole "On another machine" panel is hidden
 * when the list is empty, so the feature simply was not there.
 *
 * Only the last segment is expanded. ssh permits more, but a wildcard
 * directory in an ssh config is rare enough not to be worth walking a tree
 * for, and a pattern that matches nothing is not an error in either case.
 */
function expand(pattern: string): string[] {
  if (!pattern.includes("*") && !pattern.includes("?")) return [pattern];

  const dir = dirname(pattern);
  const name = basename(pattern);
  if (dir.includes("*") || dir.includes("?")) return [];
  if (!existsSync(dir)) return [];

  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    if (matches(entry, name)) out.push(join(dir, entry));
  }
  // Stable order, so two runs read the same files in the same order and
  // "first value wins" means the same thing each time.
  out.sort();
  return out;
}

/** Glob matching for one path segment: `*` for any run, `?` for one. */
export function matches(name: string, pattern: string): boolean {
  // glob(3) will not let a wildcard match a leading period, and ssh uses
  // glob(3). Without this, `Include conf.d/*` reads the editor swap file and
  // the .bak beside a real config, and a half-written Host block there offers
  // an alias ssh itself would never resolve.
  if (name.startsWith(".") && !pattern.startsWith(".")) return false;

  // Built rather than regex-escaped in one go, so a dot in a filename stays a
  // dot: `config.d` must not match `configXd`.
  //
  // The classes exclude "/" only. These are single names out of readdir, which
  // cannot contain a separator, and putting a backslash in the class as well
  // needs escaping that is easy to get wrong - the first attempt emitted
  // `[^/\]`, where the backslash escapes the bracket and the class never
  // closes.
  let rx = "^";
  for (const ch of pattern) {
    if (ch === "*") rx += "[^/]*";
    else if (ch === "?") rx += "[^/]";
    else if ("^$.|+()[]{}".includes(ch)) rx += "\\" + ch;
    else rx += ch;
  }
  rx += "$";
  return new RegExp(rx).test(name);
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
      // "~/" first: it is neither absolute nor relative-to-~/.ssh, and
      // joining it under ~/.ssh produced a path with a literal ~ segment
      // that existsSync then dropped in silence - the same disappearance as
      // before, one function further along. `Include ~/.ssh/config.d/*` is
      // the form this whole expansion exists for.
      const tilde = inc.startsWith("~/") ? join(homedir(), inc.substring(2)) : inc;
      // ssh resolves a relative Include against ~/.ssh, not the cwd.
      const full = isAbsolute(tilde) ? tilde : join(dirname(sshConfigPath()), tilde);
      for (const match of expand(full)) queue.push(match);
    }
  }

  return out;
}
