// AI features: the providers someone has connected, and what gitc asks of them.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO } from "../generated/version.ts";
import { git } from "./git.ts";
import { configDir, tempDir, tempFile } from "./paths.ts";
import { atOr, first } from "./safe.ts";

export interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  key: string;
  model: string;
  command: string;
}

export interface RepoProvider {
  host: string;
  path: string;
  providerId: string;
}

export interface AiConfig {
  enabled: boolean;
  features: string[];
  providers: Provider[];
  defaultId: string;
  repos: RepoProvider[];
}

export interface CommitContext {
  diff: string;
  numstat: string;
  recent: string[];
}

export interface CommitMessage {
  summary: string;
  description: string;
}

export type Answer = { text: string } | { error: string };

interface StoredProvider {
  id?: string;
  name?: string;
  kind?: string;
  baseUrl?: string;
  key?: string;
  model?: string;
  command?: string;
}

interface StoredRepo {
  host?: string;
  path?: string;
  providerId?: string;
}

interface StoredConfig {
  enabled?: boolean;
  features?: string[];
  providers?: StoredProvider[];
  defaultId?: string;
  repos?: StoredRepo[];
}

interface Launch {
  program: string;
  prefix: string[];
}

interface Ran {
  code: number;
  out: string;
  err: string;
}

const KINDS = ["openai", "anthropic", "claude-code"];
const TIMEOUT_MS = 120000;
const DIFF_CAP = 60000;
const LOCK_FILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
];

const HIDDEN_LAUNCHER =
  "const [p, ...a] = process.argv.slice(1);" +
  'require("child_process").spawn(p, a, { stdio: "inherit", windowsHide: true })' +
  ".on(\"exit\", (c) => process.exit(c === null ? 1 : c))" +
  '.on("error", (e) => { console.error(e.message); process.exit(127); });';

export const SYSTEM =
  "You write git commit messages. Answer with the message only: the subject on the first line, " +
  "then a blank line, then the body. No code fences, no quotes around it, no commentary before " +
  "or after. Match the style of the recent commits you are shown: their tense, capitalisation, " +
  "prefixes, subject length, and whether and how long they write a body. Say what the change " +
  "does and, where the diff shows it, why. Do not list every file. Never use tools.";

export function loadAi(): AiConfig {
  const path = filePath();
  if (!existsSync(path)) return defaultConfig();
  return parseConfig(readFileSync(path, "utf8"));
}

export function saveAi(incoming: AiConfig): AiConfig {
  const stored = loadAi();
  const providers: Provider[] = [];
  for (const p of incoming.providers) {
    let key = p.key;
    const old = stored.providers.find((o) => o.id === p.id);
    if (old !== undefined) {
      const shown = maskKey(old.key);
      if (shown === p.key) key = old.key;
    }
    providers.push(withKey(p, key));
  }

  const ids = providers.map((p) => p.id);
  const head = first(providers);
  const fallback = head === undefined ? "" : head.id;
  const config: AiConfig = {
    enabled: incoming.enabled,
    features: incoming.features,
    providers,
    defaultId: ids.includes(incoming.defaultId) ? incoming.defaultId : fallback,
    repos: incoming.repos.filter((r) => ids.includes(r.providerId)),
  };

  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath(), JSON.stringify(config), "utf8");
  return config;
}

export function masked(config: AiConfig): AiConfig {
  return { ...config, providers: config.providers.map((p) => withKey(p, maskKey(p.key))) };
}

export function providerFor(config: AiConfig, host: string, path: string): Provider | undefined {
  const pinned = config.repos.find((r) => r.host === host && r.path === path);
  if (pinned !== undefined) {
    const chosen = config.providers.find((p) => p.id === pinned.providerId);
    if (chosen !== undefined) return chosen;
  }
  const fallback = config.providers.find((p) => p.id === config.defaultId);
  if (fallback !== undefined) return fallback;
  return first(config.providers);
}

export async function commitContext(repo: string, amend: boolean): Promise<CommitContext> {
  const range = ["--cached"];
  if (amend) range.push(await amendBase(repo));
  const diff = await git(repo, ["diff", "--no-color", "--no-ext-diff", ...range]);
  const numstat = await git(repo, ["diff", "--numstat", ...range]);
  return { diff, numstat, recent: await recentMessages(repo) };
}

export async function writeCommitMessage(
  provider: Provider,
  context: CommitContext,
  hint: string,
): Promise<CommitMessage | { error: string }> {
  if (context.diff.trim().length === 0) return { error: "Nothing staged to describe" };
  const answer = await complete(provider, SYSTEM, buildPrompt(context, hint));
  if ("error" in answer) return { error: provider.name + ": " + answer.error };
  const message = parseReply(answer.text);
  if (message.summary.length === 0) return { error: provider.name + " returned no message" };
  return message;
}

export async function testProvider(provider: Provider): Promise<{ ms: number } | { error: string }> {
  const started = Date.now();
  const answer = await complete(provider, "Answer with the single word OK.", "Say OK.");
  if ("error" in answer) return { error: answer.error };
  return { ms: Date.now() - started };
}

export async function complete(provider: Provider, system: string, user: string): Promise<Answer> {
  if (provider.kind === "claude-code") return claudeCode(provider, system, user);
  if (provider.model.trim().length === 0) return { error: "no model set" };
  if (provider.kind === "anthropic") return anthropic(provider, system, user);
  return openai(provider, system, user);
}

async function openai(provider: Provider, system: string, user: string): Promise<Answer> {
  const key = resolveKey(provider.key);
  const url = trimSlash(provider.baseUrl) + "/chat/completions";
  const headers = ["content-type: application/json"];
  if (key.length > 0) headers.push("authorization: Bearer " + key);
  if (url.includes("openrouter.ai")) {
    headers.push("http-referer: https://github.com/" + REPO);
    headers.push("x-title: gitc");
  }
  const body = JSON.stringify({
    model: provider.model.trim(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const got = await post(url, headers, body);
  if ("error" in got) return { error: scrub(got.error, key) };
  try {
    const parsed = JSON.parse(got.text) as {
      choices?: { message?: { content?: string | null } }[];
      error?: { message?: string };
    };
    const failure = parsed.error?.message ?? "";
    if (got.status >= 400 || failure.length > 0) {
      return { error: scrub(String(got.status) + " " + (failure.length > 0 ? failure : got.text), key) };
    }
    const choice = first(parsed.choices ?? []);
    const content = choice === undefined ? undefined : choice.message?.content;
    return { text: content ?? "" };
  } catch {
    return { error: scrub(String(got.status) + " " + got.text.substring(0, 300), key) };
  }
}

async function anthropic(provider: Provider, system: string, user: string): Promise<Answer> {
  const key = resolveKey(provider.key);
  if (key.length === 0) return { error: "no API key set" };
  const headers = ["content-type: application/json", "x-api-key: " + key, "anthropic-version: 2023-06-01"];
  const body = JSON.stringify({
    model: provider.model.trim(),
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
  });

  const got = await post("https://api.anthropic.com/v1/messages", headers, body);
  if ("error" in got) return { error: scrub(got.error, key) };
  try {
    const parsed = JSON.parse(got.text) as {
      content?: { type?: string; text?: string }[];
      stop_reason?: string | null;
      error?: { message?: string };
    };
    const failure = parsed.error?.message ?? "";
    if (got.status >= 400 || failure.length > 0) {
      return { error: scrub(String(got.status) + " " + (failure.length > 0 ? failure : got.text), key) };
    }
    if (parsed.stop_reason === "refusal") return { error: "the model declined to answer" };
    let text = "";
    for (const block of parsed.content ?? []) {
      if (block.type !== "text") continue;
      const piece = block.text;
      if (piece !== undefined) text += piece;
    }
    return { text };
  } catch {
    return { error: scrub(String(got.status) + " " + got.text.substring(0, 300), key) };
  }
}

async function claudeCode(provider: Provider, system: string, user: string): Promise<Answer> {
  const command = provider.command.trim().length > 0 ? provider.command.trim() : "claude";
  const launch = findCommand(command);
  if (launch === undefined) return { error: command + " not found - is Claude Code installed and on PATH?" };

  const args = [...launch.prefix, "-p", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--system-prompt", system];
  const model = provider.model.trim();
  if (model.length > 0) args.push("--model", model);

  const ran = await exec(launch.program, args, user);
  if ("error" in ran) return ran.error.includes("ENOENT") ? { error: command + " not found - is Claude Code installed and on PATH?" } : ran;
  if (ran.code !== 0) {
    const said = (ran.err.trim().length > 0 ? ran.err : ran.out).trim();
    return { error: said.length > 0 ? said.substring(0, 500) : command + " exited with " + String(ran.code) };
  }
  return { text: ran.out };
}

async function post(
  url: string,
  headers: string[],
  body: string,
): Promise<{ status: number; text: string } | { error: string }> {
  const bodyFile = tempFile("ai-" + String(Date.now()) + "-" + String(Math.floor(Math.random() * 1e9)) + ".json");
  writeFileSync(bodyFile, body, "utf8");
  const lines = [
    'url = "' + quoted(url) + '"',
    'request = "POST"',
    'data-binary = "@' + quoted(bodyFile) + '"',
    'connect-timeout = "10"',
    'max-time = "' + String(TIMEOUT_MS / 1000) + '"',
    'write-out = "\\n%{http_code}"',
  ];
  for (const h of headers) lines.push('header = "' + quoted(h) + '"');

  try {
    const ran = await exec("curl", ["-sS", "--config", "-"], lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
    if ("error" in ran) return ran.error.includes("ENOENT") ? { error: "curl not found" } : ran;
    if (ran.code === 28) return { error: "no answer after " + String(TIMEOUT_MS / 1000) + " s" };
    if (ran.code !== 0) return { error: ran.err.trim().length > 0 ? ran.err.trim() : "curl exited with " + String(ran.code) };
    const cut = ran.out.lastIndexOf(String.fromCharCode(10));
    const status = Number(ran.out.substring(cut + 1).trim());
    return { status: Number.isNaN(status) ? 0 : status, text: ran.out.substring(0, Math.max(cut, 0)) };
  } finally {
    rmSync(bodyFile, { force: true });
  }
}

function exec(command: string, args: string[], input: string): Promise<Ran | { error: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: true, cwd: tempDir() });

    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let code = 0;
    let exited = false;
    let open = 2;
    let done = false;

    const finish = (result: Ran | { error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const settle = () => {
      if (!exited || open > 0) return;
      finish({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ error: "no answer after " + String(TIMEOUT_MS / 1000) + " s" });
    }, TIMEOUT_MS);

    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdin === null || stdout === null || stderr === null) {
      finish({ error: command + " produced no output streams" });
      return;
    }
    stdin.write(input);
    stdin.end();

    stdout.on("data", (chunk: Buffer) => out.push(chunk));
    stdout.on("end", () => {
      open -= 1;
      settle();
    });
    stderr.on("data", (chunk: Buffer) => err.push(chunk));
    stderr.on("end", () => {
      open -= 1;
      settle();
    });
    child.on("exit", (status: number | null) => {
      code = status === null ? 1 : status;
      exited = true;
      settle();
    });
    child.on("error", (e: Error) => finish({ error: e.message }));
  });
}

export function buildPrompt(context: CommitContext, hint: string): string {
  const parts: string[] = [];
  const examples = context.recent.map((m) => m.trim()).filter((m) => m.length > 0);
  if (examples.length > 0) {
    parts.push(
      "Recent commit messages in this repository, newest first, as style examples:\n\n" +
        examples.join("\n\n-----\n\n"),
    );
  }
  if (hint.trim().length > 0) {
    parts.push("The author's own note about this change. Take it as the intent and improve the wording:\n\n" + hint.trim());
  }
  parts.push("The staged changes:\n\n" + trimDiff(context.diff, context.numstat, DIFF_CAP));
  return parts.join("\n\n=====\n\n");
}

export function trimDiff(diff: string, numstat: string, cap: number): string {
  const counts = new Map<string, string>();
  for (const line of numstat.split("\n")) {
    const cells = line.split("\t");
    if (cells.length < 3) continue;
    const added = atOr(cells, 0, "");
    const removed = atOr(cells, 1, "");
    const name = cells.slice(2).join("\t");
    let count = "binary";
    if (added !== "-") count = "+" + added + " -" + removed;
    counts.set(name, count);
  }

  const kept: string[] = [];
  const summarised: string[] = [];
  const omitted: string[] = [];
  let size = 0;
  for (const section of sections(diff)) {
    const name = sectionPath(section);
    let count = "";
    const known = counts.get(name);
    if (known !== undefined) count = known;
    if (isBinary(section)) {
      summarised.push(name + " (binary)");
      continue;
    }
    if (isLockFile(name)) {
      summarised.push(withCount(name + " (lock file", count, ", ") + ")");
      continue;
    }
    if (size + section.length > cap) {
      omitted.push(withCount(name, count, " "));
      continue;
    }
    size += section.length;
    kept.push(section);
  }

  let text = kept.join("");
  if (summarised.length > 0) text += "\nAlso changed, contents not shown:\n" + summarised.join("\n") + "\n";
  if (omitted.length > 0) text += "\nAlso changed, left out for length:\n" + omitted.join("\n") + "\n";
  return text;
}

export function parseReply(reply: string): CommitMessage {
  let text = reply.split("\r\n").join("\n").trim();
  if (text.startsWith("```")) {
    const firstBreak = text.indexOf("\n");
    text = firstBreak === -1 ? "" : text.substring(firstBreak + 1);
    if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
    text = text.trim();
  }
  text = unwrap(unwrap(unwrap(text, '"'), "'"), "`");

  const lines = text.split("\n");
  const index = lines.findIndex((l) => l.trim().length > 0);
  if (index === -1) return { summary: "", description: "" };
  return { summary: atOr(lines, index, "").trim(), description: lines.slice(index + 1).join("\n").trim() };
}

export function maskKey(key: string): string {
  if (key.length === 0 || key.startsWith("$")) return key;
  if (key.length <= 12) return "...";
  return key.substring(0, 6) + "..." + key.substring(key.length - 4);
}

export function parseConfig(text: string): AiConfig {
  try {
    const raw = JSON.parse(text) as StoredConfig;
    const providers: Provider[] = [];
    for (const p of raw.providers ?? []) {
      const restored = restoreProvider(p);
      if (usable(restored)) providers.push(restored);
    }
    const repos: RepoProvider[] = [];
    for (const r of raw.repos ?? []) repos.push(restoreRepo(r));
    return {
      enabled: raw.enabled ?? false,
      features: raw.features ?? ["commitMessage"],
      providers,
      defaultId: raw.defaultId ?? "",
      repos,
    };
  } catch {
    return defaultConfig();
  }
}

export function defaultConfig(): AiConfig {
  return { enabled: false, features: ["commitMessage"], providers: [], defaultId: "", repos: [] };
}

function withKey(p: Provider, key: string): Provider {
  return { id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, key, model: p.model, command: p.command };
}

function usable(p: Provider): boolean {
  return p.id.length > 0 && KINDS.includes(p.kind);
}

function restoreRepo(r: StoredRepo): RepoProvider {
  return { host: r.host ?? "", path: r.path ?? "", providerId: r.providerId ?? "" };
}

function restoreProvider(p: StoredProvider): Provider {
  return {
    id: p.id ?? "",
    name: p.name ?? "",
    kind: p.kind ?? "",
    baseUrl: p.baseUrl ?? "",
    key: p.key ?? "",
    model: p.model ?? "",
    command: p.command ?? "",
  };
}

async function amendBase(repo: string): Promise<string> {
  try {
    return (await git(repo, ["rev-parse", "--verify", "-q", "HEAD^"])).trim();
  } catch {
    return (await git(repo, ["hash-object", "-t", "tree", "--stdin"], undefined, "")).trim();
  }
}

async function recentMessages(repo: string): Promise<string[]> {
  try {
    const log = await git(repo, ["log", "-20", "--format=%B%x00", "HEAD"]);
    return log.split(String.fromCharCode(0));
  } catch {
    const none: string[] = [];
    return none;
  }
}

function sections(diff: string): string[] {
  const out: string[] = [];
  let start = diff.indexOf("diff --git ");
  while (start !== -1) {
    const next = diff.indexOf("\ndiff --git ", start + 1);
    const end = next === -1 ? diff.length : next + 1;
    out.push(diff.substring(start, end));
    start = next === -1 ? -1 : next + 1;
  }
  return out;
}

function sectionPath(section: string): string {
  const header = section.substring(0, section.indexOf("\n") === -1 ? section.length : section.indexOf("\n"));
  const at = header.lastIndexOf(" b/");
  return at === -1 ? header : header.substring(at + 3);
}

function findCommand(command: string): Launch | undefined {
  if (process.platform !== "win32") return { program: command, prefix: [] };
  for (const candidate of candidates(command)) {
    const launch = launchFor(candidate);
    if (launch !== undefined) return hidden(launch);
  }
  return;
}

function hidden(launch: Launch): Launch {
  const program = launch.program.toLowerCase();
  const node = program.endsWith("node.exe") || program === "node" ? launch.program : findNode();
  if (node === undefined) return launch;
  return { program: node, prefix: ["-e", HIDDEN_LAUNCHER, launch.program, ...launch.prefix] };
}

function findNode(): string | undefined {
  for (const candidate of candidates("node")) {
    const exe = candidate.toLowerCase().endsWith(".exe");
    if (!exe) continue;
    if (existsSync(candidate)) return candidate;
  }
  return;
}

function candidates(command: string): string[] {
  const named = [command, command + ".exe", command + ".cmd"];
  if (command.includes("/") || command.includes("\\")) return named;
  const out: string[] = [];
  for (const dir of (process.env["PATH"] ?? process.env["Path"] ?? "").split(";")) {
    if (dir.length === 0) continue;
    out.push(join(dir, command + ".exe"));
    out.push(join(dir, command + ".cmd"));
  }
  return out;
}

function launchFor(file: string): Launch | undefined {
  if (!existsSync(file)) return;
  const lower = file.toLowerCase();
  if (lower.endsWith(".exe")) return { program: file, prefix: [] };
  if (!lower.endsWith(".cmd")) return;
  const dir = dirname(file);
  const cli = join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (!existsSync(cli)) return;
  const node = join(dir, "node.exe");
  return { program: existsSync(node) ? node : "node", prefix: [cli] };
}

function isBinary(section: string): boolean {
  return section.includes("\nBinary files ") || section.includes("\nGIT binary patch");
}

function withCount(text: string, count: string, separator: string): string {
  return count.length > 0 ? text + separator + count : text;
}

function unwrap(text: string, mark: string): string {
  if (text.length < 2 || !text.startsWith(mark) || !text.endsWith(mark)) return text;
  return text.slice(1, -1).trim();
}

function isLockFile(path: string): boolean {
  const slash = path.lastIndexOf("/");
  return LOCK_FILES.includes(slash === -1 ? path : path.substring(slash + 1));
}

function resolveKey(key: string): string {
  if (!key.startsWith("$")) return key.trim();
  return (process.env[key.substring(1)] ?? "").trim();
}

function scrub(text: string, key: string): string {
  return key.length > 0 ? text.split(key).join("[key]") : text;
}

function quoted(value: string): string {
  return value.split("\\").join("\\\\").split('"').join('\\"');
}

function trimSlash(url: string): string {
  let out = url.trim();
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function filePath(): string {
  return join(configDir(), "ai.json");
}
