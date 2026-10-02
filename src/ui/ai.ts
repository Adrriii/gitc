import { useEffect, useState } from "react";
import { api } from "./api";
import type { AiConfig, AiProvider } from "./types";

export const AI_KINDS = [
  {
    kind: "openai",
    label: "OpenAI-compatible",
    hint: "OpenRouter, OpenAI, Ollama, LM Studio, or any server speaking the same API",
  },
  { kind: "anthropic", label: "Anthropic", hint: "The Anthropic API, with your own key" },
  { kind: "claude-code", label: "Claude Code", hint: "The claude on this machine, signed in to your Claude account" },
];

export const AI_FEATURES = [
  {
    id: "commitMessage",
    label: "Commit message",
    hint: "A button inside the commit summary writes the summary and description from the staged changes, in the style of this repository's recent commits. Anything already typed in either box is taken as a hint.",
  },
  {
    id: "explainCommit",
    label: "Explain commits",
    hint: "A button in the commit panel explains the selected commit, or commits, in a few plain paragraphs.",
  },
  {
    id: "branchName",
    label: "Branch name",
    hint: "A button in the new branch box names the branch after your uncommitted changes, in the style of this repository's branches.",
  },
  {
    id: "squashMessage",
    label: "Squash message",
    hint: "Squashing writes one message for the result from the commits' messages and their combined change, instead of joining the messages together.",
  },
  {
    id: "conflictAssist",
    label: "Conflict picks",
    hint: "The merge editor can suggest which lines to keep from each side. It only ever picks lines, and says so when a conflict needs more than that.",
  },
];

const EVENT = "gitc:ai";
let current: AiConfig | undefined;
let loading: Promise<void> | undefined;

export function useAi() {
  const [config, setConfig] = useState(current);

  useEffect(() => {
    const sync = () => setConfig(current);
    window.addEventListener(EVENT, sync);
    if (current === undefined) void load();
    else sync();
    return () => window.removeEventListener(EVENT, sync);
  }, []);

  return {
    config,
    feature: (name: string) => config !== undefined && config.enabled && config.features.includes(name),
    save: saveAi,
  };
}

export async function saveAi(next: AiConfig): Promise<void> {
  current = next;
  publish();
  try {
    current = await api.saveAi(next);
  } catch (e) {
    console.warn("gitc: saving the AI settings failed", e);
    loading = undefined;
    await load();
    return;
  }
  publish();
}

export function providerFor(
  config: AiConfig,
  host: string,
  path: string,
): { provider: AiProvider; pinned: boolean } | undefined {
  const pinned = config.repos.find((r) => r.host === host && r.path === path);
  const chosen = config.providers.find((p) => p.id === pinned?.providerId);
  if (chosen !== undefined) return { provider: chosen, pinned: true };
  const fallback = config.providers.find((p) => p.id === config.defaultId) ?? config.providers[0];
  if (fallback === undefined) return;
  return { provider: fallback, pinned: false };
}

export function kindLabel(kind: string): string {
  return AI_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

function load(): Promise<void> {
  if (loading === undefined) {
    loading = api
      .ai()
      .then((c) => {
        current = c;
        publish();
      })
      .catch((e: unknown) => console.warn("gitc: reading the AI settings failed", e));
  }
  return loading;
}

function publish() {
  window.dispatchEvent(new Event(EVENT));
}
