// Which machine is on the other end, and what it needs.
//
// Separate from remote.ts because the asymmetry is a trap: the first version
// of this assumed "I am Windows, therefore the remote is Linux" and hardcoded
// the Linux asset. The connection is not a direction. A Linux workstation
// reaching a Windows build agent is the same feature, and gets the same
// answer here.
//
// Nothing in this file asks what platform gitc is RUNNING on. That is never
// the question; the question is always what the remote is.

import { atOr } from "./safe.ts";

/** Platforms gitc publishes a binary for, plus the ones it can only name. */
export type RemotePlatform = "linux" | "windows" | "macos" | "unknown";

export interface RemoteKind {
  platform: RemotePlatform;
  /** The release asset this platform needs, or null if none is published. */
  asset: string | null;
  /** Where the binary goes, as the remote's own shell would write it. */
  binPath: string | null;
  /** Why this remote cannot be used, or null when it can. */
  refusal: string | null;
}

/**
 * Reads `uname -s` and falls back to asking Windows for its version.
 *
 * One probe rather than two round trips: a POSIX remote answers the `uname`
 * and never reaches the rest, while a Windows OpenSSH remote running cmd.exe
 * fails the `uname` and answers `ver`. The `||` is shell on one side and, on
 * cmd, simply the next thing it manages to run - which is why the output is
 * matched rather than the exit code.
 */
export const DETECT_COMMAND = "uname -s 2>/dev/null || ver";

export function classify(probeOutput: string): RemoteKind {
  const text = probeOutput.trim();
  const lower = text.toLowerCase();

  if (lower.startsWith("linux")) {
    return {
      platform: "linux",
      asset: "gitc",
      // Already on PATH in most distributions' default profile, and where
      // install() puts it when gitc installs itself locally.
      binPath: "~/.local/bin/gitc",
      refusal: null,
    };
  }

  if (lower.includes("microsoft windows") || lower.includes("windows [version")) {
    return {
      platform: "windows",
      asset: "gitc.exe",
      binPath: null,
      // A published binary exists, so this is a shell problem rather than a
      // missing build: every command here is POSIX sh, and a Windows OpenSSH
      // server hands them to cmd.exe. Supporting it means a second spelling of
      // the install script and of the launch, not a second binary.
      refusal:
        "gitc can reach Windows hosts once its remote install speaks cmd as well as sh - " +
        "the binary exists, the shell script does not",
    };
  }

  if (lower.startsWith("darwin")) {
    return {
      platform: "macos",
      asset: null,
      binPath: null,
      // Nothing to send: the release publishes gitc and gitc.exe only.
      refusal: "gitc does not publish a macOS binary yet, so there is nothing to install there",
    };
  }

  return {
    platform: "unknown",
    asset: null,
    binPath: null,
    refusal:
      text.length === 0
        ? "the remote did not say what it is"
        : "unrecognised remote platform: " + text.split("\n")[0],
  };
}
