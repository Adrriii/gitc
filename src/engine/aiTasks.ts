// The AI features beyond the commit message: explaining commits, naming a
// branch, writing a squash message, and suggesting picks in a conflict.

import { DIFF_CAP, SYSTEM, complete, parseReply, trimDiff } from "./ai.ts";
import type { CommitContext, CommitMessage, Provider } from "./ai.ts";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { at, atOr, last } from "./safe.ts";

export interface ConflictHunk {
  ours: string[];
  theirs: string[];
  base: string[] | null;
  before: string[];
  after: string[];
}

export type Pick = { ours: number[]; theirs: number[] } | { reason: string };

const EXPLAIN_SYSTEM =
  "You explain git commits to a developer reviewing them. Write two to five short plain paragraphs: " +
  "what changed, why it seems to have changed, and anything risky or worth checking. No headings, " +
  "no bullet lists, no code fences. Never use tools.";

const BRANCH_SYSTEM =
  "You name git branches. Answer with the branch name only, on one line: lowercase, words joined by " +
  "hyphens, at most five words, in the naming style of the existing branches you are shown, with a " +
  "prefix such as feature/ or fix/ when they use one. When the changes are only new files, name the branch after " +
  "what they add. Never use tools.";

const CONFLICT_SYSTEM = [
  "You resolve git merge conflicts by choosing lines, never by writing code.",
  "Each conflict shows side A and side B with every line numbered from 1, the common ancestor when known, and some surrounding lines.",
  "The result of a conflict is the lines kept from A in their order, followed by the lines kept from B in their order. Nothing else can be produced.",
  "Answer one line per conflict, exactly in this form: <n>: A <lines> B <lines>",
  "where <lines> is a comma separated list of line numbers or ranges such as 1-3, or the word none.",
  "When the right result needs lines in another order, text neither side has, or nothing from either side, answer instead: <n>: unresolved <short reason>",
  "Do not guess. No other text. Never use tools.",
].join("\n");

const CONFLICT_CAP = 60000;
const NEW_FILES = 10;
const NEW_FILE_BYTES = 20000;
const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const SHA = /^[0-9a-fA-F]{4,64}$/;

export async function taskContext(
  repo: string,
  kind: string,
  shas: string[],
): Promise<CommitContext | { error: string }> {
  if (kind === "branch") return branchContext(repo);
  for (const sha of shas) {
    if (!SHA.test(sha)) return { error: "not a commit: " + sha };
  }
  if (shas.length === 0) return { error: "no commits given" };

  const ordered = shas.slice().reverse();
  const log = await quiet(repo, ["log", "--no-walk=unsorted", "--format=%B%x00", ...ordered]);
  const messages = log
    .split(NUL)
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  if (kind === "explain") {
    const diff = await quiet(repo, ["show", "--no-color", "--no-ext-diff", "--format=", ...ordered]);
    const numstat = await quiet(repo, ["show", "--numstat", "--format=", ...ordered]);
    return { diff, numstat, recent: messages };
  }
  if (kind === "squash") {
    const oldest = atOr(ordered, 0, "");
    const newest = last(ordered) ?? oldest;
    const base = await parentOf(repo, oldest);
    const diff = await quiet(repo, ["diff", "--no-color", "--no-ext-diff", base, newest]);
    const numstat = await quiet(repo, ["diff", "--numstat", base, newest]);
    return { diff, numstat, recent: messages };
  }
  return { error: "unknown context: " + kind };
}

export async function explainCommits(
  provider: Provider,
  context: CommitContext,
): Promise<{ text: string } | { error: string }> {
  if (context.diff.trim().length === 0 && context.recent.length === 0) return { error: "Nothing to explain" };
  const user =
    "Commit messages, oldest first:" + LF + LF + context.recent.join(LF + LF + "-----" + LF + LF) +
    LF + LF + "=====" + LF + LF + "The changes:" + LF + LF + trimDiff(context.diff, context.numstat, DIFF_CAP);
  const answer = await complete(provider, EXPLAIN_SYSTEM, user);
  if ("error" in answer) return { error: provider.name + ": " + answer.error };
  const text = unfence(answer.text);
  if (text.length === 0) return { error: provider.name + " returned no explanation" };
  return { text };
}

export async function suggestBranchName(
  provider: Provider,
  context: CommitContext,
): Promise<{ name: string } | { error: string }> {
  if (context.diff.trim().length === 0) return { error: "No changes to name a branch after" };
  const user =
    "Existing branches, most recent first, as style examples:" + LF + context.recent.join(LF) +
    LF + LF + "=====" + LF + LF + "The uncommitted changes:" + LF + LF +
    trimDiff(context.diff, context.numstat, DIFF_CAP);
  const answer = await complete(provider, BRANCH_SYSTEM, user);
  if ("error" in answer) return { error: provider.name + ": " + answer.error };
  const name = branchSlug(parseReply(answer.text).summary);
  if (name.length === 0 || name.split(/[-/]/).length > 8) return { error: provider.name + " returned no usable name" };
  return { name };
}

export async function writeSquashMessage(
  provider: Provider,
  context: CommitContext,
): Promise<CommitMessage | { error: string }> {
  const user =
    "These commits are being squashed into one. Write the one message the result should have. " +
    "Their messages, oldest first, also show this repository's style:" + LF + LF +
    context.recent.join(LF + LF + "-----" + LF + LF) +
    LF + LF + "=====" + LF + LF + "The combined change:" + LF + LF +
    trimDiff(context.diff, context.numstat, DIFF_CAP);
  const answer = await complete(provider, SYSTEM, user);
  if ("error" in answer) return { error: provider.name + ": " + answer.error };
  const message = parseReply(answer.text);
  if (message.summary.length === 0) return { error: provider.name + " returned no message" };
  return message;
}

export async function suggestPicks(
  provider: Provider,
  path: string,
  hunks: ConflictHunk[],
): Promise<{ picks: Pick[] } | { error: string }> {
  if (hunks.length === 0) return { error: "No conflicts in this file" };
  const answer = await complete(provider, CONFLICT_SYSTEM, conflictPrompt(path, hunks));
  if ("error" in answer) return { error: provider.name + ": " + answer.error };
  return { picks: parsePicks(answer.text, hunks) };
}

export function conflictPrompt(path: string, hunks: ConflictHunk[]): string {
  const parts: string[] = ["File: " + path];
  let size = 0;
  for (let i = 0; i < hunks.length; i++) {
    const hunk = at(hunks, i);
    if (hunk === undefined) continue;
    const text = describeHunk(i + 1, hunk);
    if (size + text.length > CONFLICT_CAP) {
      parts.push("Conflicts " + String(i + 1) + " to " + String(hunks.length) + " are left out for length; answer only for those above.");
      break;
    }
    size += text.length;
    parts.push(text);
  }
  return parts.join(LF + LF);
}

export function parsePicks(reply: string, hunks: ConflictHunk[]): Pick[] {
  const answers = new Map<number, string>();
  for (const raw of reply.split(LF)) {
    const line = raw.trim();
    const m = /^\D{0,12}?(\d+)\s*[:.)-]\s*(.+)$/.exec(line);
    if (m === null) continue;
    const n = Number(atOr(m, 1, "0"));
    const rest = atOr(m, 2, "");
    if (answers.has(n)) continue;
    answers.set(n, rest);
  }

  const picks: Pick[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const hunk = at(hunks, i);
    const said = answers.get(i + 1);
    if (hunk === undefined || said === undefined) {
      picks.push({ reason: "no suggestion for this conflict" });
      continue;
    }
    picks.push(pickFrom(said, hunk));
  }
  return picks;
}

export function branchSlug(text: string): string {
  let name = text.trim().toLowerCase();
  for (const mark of ["`", '"', "'"]) name = name.split(mark).join("");
  name = name.replace(/\s+/g, "-").replace(/[^a-z0-9/._-]/g, "");
  name = name.replace(/-{2,}/g, "-").replace(/\/{2,}/g, "/").replace(/\.{2,}/g, ".");
  name = name.replace(/^[-/.]+|[-/.]+$/g, "");
  if (name.endsWith(".lock")) name = name.slice(0, -5);
  return name.substring(0, 60).replace(/[-/.]+$/g, "");
}

function pickFrom(said: string, hunk: ConflictHunk): Pick {
  const unresolved = /^unresolved\b[\s:,-]*(.*)$/i.exec(said);
  if (unresolved !== null) {
    const why = atOr(unresolved, 1, "").trim();
    return { reason: why.length > 0 ? why : "cannot be resolved by picking lines" };
  }
  const m = /\bA\s*:?\s*([\d,\s-]+|none)\s*,?\s*\bB\s*:?\s*([\d,\s-]+|none)\s*$/i.exec(said);
  if (m === null) return { reason: "the suggestion could not be read" };
  const ours = lineList(atOr(m, 1, ""), hunk.ours.length);
  const theirs = lineList(atOr(m, 2, ""), hunk.theirs.length);
  if (ours === undefined || theirs === undefined) return { reason: "the suggestion named lines this conflict does not have" };
  if (ours.length === 0 && theirs.length === 0) return { reason: "it would keep nothing from either side" };
  return { ours, theirs };
}

function lineList(text: string, count: number): number[] | undefined {
  const out: number[] = [];
  const spec = text.trim().toLowerCase();
  if (spec === "none" || spec.length === 0) return out;
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (part.length === 0) continue;
    const bounds = part.split("-").map((b) => Number(b.trim()));
    const from = atOr(bounds, 0, NaN);
    const to = atOr(bounds, bounds.length - 1, NaN);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > count || from > to) return;
    for (let n = from; n <= to; n++) {
      const index = n - 1;
      if (!out.includes(index)) out.push(index);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

function describeHunk(n: number, hunk: ConflictHunk): string {
  let lines: string[] = ["Conflict " + String(n)];
  if (hunk.before.length > 0) lines = lines.concat(["Lines before:"], hunk.before);
  lines = lines.concat(["Side A:"], numbered(hunk.ours), ["Side B:"], numbered(hunk.theirs));
  const base = hunk.base;
  if (base !== null) lines = lines.concat(["Common ancestor:"], base);
  if (hunk.after.length > 0) lines = lines.concat(["Lines after:"], hunk.after);
  return lines.join(LF);
}

function numbered(lines: string[]): string[] {
  if (lines.length === 0) return ["(empty)"];
  return lines.map((l, i) => String(i + 1) + "| " + l);
}

async function branchContext(repo: string): Promise<CommitContext> {
  const diff = await quiet(repo, ["diff", "--no-color", "--no-ext-diff", "HEAD"]);
  const numstat = await quiet(repo, ["diff", "--numstat", "HEAD"]);
  const untracked = (await quiet(repo, ["ls-files", "--others", "--exclude-standard"])).trim();
  const refs = await quiet(repo, [
    "for-each-ref",
    "--count=30",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  const branches = refs
    .split(LF)
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && !r.endsWith("/HEAD"));
  return { diff: diff + newFiles(repo, untracked.split(LF)), numstat, recent: branches };
}

function newFiles(repo: string, names: string[]): string {
  let out = "";
  let shown = 0;
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    let body = "(not shown)";
    if (shown < NEW_FILES) {
      const content = smallText(join(repo, name));
      if (content !== undefined) {
        body = content;
        shown += 1;
      }
    }
    out += LF + "New file, not tracked yet: " + name + LF + body + LF;
  }
  return out;
}

function smallText(path: string): string | undefined {
  try {
    if (statSync(path).size > NEW_FILE_BYTES) return;
    const text = readFileSync(path, "utf8");
    if (text.includes(NUL)) return;
    return text;
  } catch {
    return;
  }
}

async function parentOf(repo: string, sha: string): Promise<string> {
  const parent = (await quiet(repo, ["rev-parse", "--verify", "-q", sha + "^"])).trim();
  if (parent.length > 0) return parent;
  try {
    return (await git(repo, ["hash-object", "-t", "tree", "--stdin"], undefined, "")).trim();
  } catch {
    return sha;
  }
}

async function quiet(repo: string, args: string[]): Promise<string> {
  try {
    return await git(repo, args);
  } catch {
    return "";
  }
}

function unfence(text: string): string {
  let out = text.split("\r\n").join(LF).trim();
  if (!out.startsWith("```")) return out;
  const firstBreak = out.indexOf(LF);
  out = firstBreak === -1 ? "" : out.substring(firstBreak + 1);
  if (out.trimEnd().endsWith("```")) out = out.trimEnd().slice(0, -3);
  return out.trim();
}
