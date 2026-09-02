// Co-authorship, which git has no field for.
//
// The convention is a `Co-authored-by:` trailer at the end of the message, and
// forges read it to credit more than one person for a commit. The engine
// already lifts those lines out for display (git.ts); this is the other half -
// what the message editor needs to show them as people, let them be changed,
// and put them back as trailers when the message is written.

import type { Commit, Person } from "./types";

const TRAILER = "co-authored-by:";
const LABEL = "Co-authored-by: ";

/**
 * Splits `Name <email>` as a trailer spells it.
 *
 * Tolerant on purpose - these are typed by hand and by a dozen different
 * tools, so a missing bracket should still credit the person rather than
 * losing them. Mirrors parsePerson() in engine/git.ts.
 */
export function parsePerson(value: string): Person | null {
  const text = value.trim();
  if (text.length === 0) return null;
  const open = text.lastIndexOf("<");
  const close = text.lastIndexOf(">");
  if (open === -1 || close < open) return { name: text, email: "" };
  const name = text.substring(0, open).trim();
  const email = text.substring(open + 1, close).trim();
  return { name: name.length > 0 ? name : email, email };
}

/** How a trailer writes one person. */
export function formatPerson(person: Person): string {
  const name = person.name.trim();
  const email = person.email.trim();
  if (email.length === 0) return name;
  return name.length > 0 ? `${name} <${email}>` : `<${email}>`;
}

/** Two entries for the same person, however each of them was spelled. */
function key(person: Person): string {
  return person.email.trim().toLowerCase() || person.name.trim().toLowerCase();
}

/**
 * Takes the co-author trailers out of a message body.
 *
 * They come out so the editor can show them as people rather than as text
 * nobody reads - and, more importantly, so that editing the body cannot
 * accidentally break a trailer and drop whoever it credited.
 */
export function splitCoAuthors(body: string): { body: string; coAuthors: Person[] } {
  const kept: string[] = [];
  const coAuthors: Person[] = [];
  const seen = new Set<string>();

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(TRAILER)) {
      const person = parsePerson(trimmed.substring(TRAILER.length));
      if (person !== null && !seen.has(key(person))) {
        seen.add(key(person));
        coAuthors.push(person);
      }
      continue;
    }
    kept.push(line);
  }

  return { body: kept.join("\n").trim(), coAuthors };
}

/**
 * Builds the whole message git will be given: subject, body, trailers.
 *
 * The blank line before the trailers is what makes them trailers rather than
 * the last paragraph of the body - git's own interpret-trailers, and every
 * forge that reads them, wants the block on its own.
 */
export function buildMessage(summary: string, body: string, coAuthors: Person[]): string {
  const parts: string[] = [summary.trim()];
  const text = body.trim();
  if (text.length > 0) parts.push(text);

  const credited = coAuthors
    .filter((p) => p.name.trim().length > 0 || p.email.trim().length > 0)
    .map((p) => LABEL + formatPerson(p));
  if (credited.length > 0) parts.push(credited.join("\n"));

  return parts.join("\n\n");
}

export interface Contributor {
  person: Person;
  /** Commits authored, across the loaded history. */
  count: number;
}

/**
 * Who commits here, most active first - the list the picker offers.
 *
 * Built from the graph already in hand rather than asked of the engine: the
 * loaded history is exactly the population "who works on this" is a question
 * about, and a round trip to rank it would be a round trip to learn something
 * the UI can already see.
 *
 * Co-author trailers count too. Somebody who is always credited as a
 * co-author and never as the author is precisely who this list should offer,
 * and ranking only by authorship would leave them out.
 */
export function contributors(commits: Commit[], exclude: Person[] = []): Contributor[] {
  const skip = new Set(exclude.map(key));
  const counts = new Map<string, Contributor>();

  const add = (person: Person) => {
    const id = key(person);
    if (id.length === 0 || skip.has(id)) return;
    const seen = counts.get(id);
    if (seen === undefined) counts.set(id, { person, count: 1 });
    else seen.count += 1;
  };

  for (const c of commits) {
    add({ name: c.author, email: c.email });
    for (const p of c.coAuthors ?? []) add(p);
  }

  // Most active first, then alphabetically so the tail does not reshuffle
  // itself every time a commit lands.
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.person.name.localeCompare(b.person.name),
  );
}

/** Filters the picker's list by what has been typed into it. */
export function matching(list: Contributor[], query: string): Contributor[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return list;
  return list.filter(
    (c) =>
      c.person.name.toLowerCase().includes(q) || c.person.email.toLowerCase().includes(q),
  );
}
