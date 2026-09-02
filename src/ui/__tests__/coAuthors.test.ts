// Co-author trailers, both directions.
//
// Worth testing because the round trip is lossy in exactly one direction that
// matters: a message read, edited and written back must still credit everyone
// it credited before, and must not credit anyone twice.

import {
  buildMessage,
  contributors,
  formatPerson,
  matching,
  parsePerson,
  splitCoAuthors,
} from "../coAuthors.ts";
import type { Commit, Person } from "../types.ts";

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

// --- parsing a person -----------------------------------------------------

eq("name and email", parsePerson("Ada Lovelace <ada@example.com>"), {
  name: "Ada Lovelace",
  email: "ada@example.com",
});

// Typed by hand and by a dozen tools, so a missing bracket credits the person
// rather than losing them.
eq("no brackets", parsePerson("Ada Lovelace"), { name: "Ada Lovelace", email: "" });
eq("email only", parsePerson("<ada@example.com>"), {
  name: "ada@example.com",
  email: "ada@example.com",
});
eq("blank is nobody", parsePerson("   "), null);

eq("formatting round-trips", formatPerson({ name: "Ada", email: "ada@example.com" }), "Ada <ada@example.com>");
eq("no email, no brackets", formatPerson({ name: "Ada", email: "" }), "Ada");

// --- splitting them out of a body -----------------------------------------

const body = [
  "why this happened",
  "",
  "and a second paragraph",
  "",
  "Co-authored-by: Ada Lovelace <ada@example.com>",
  "co-authored-by: Grace Hopper <grace@example.com>",
].join("\n");

eq("the body keeps its own text", splitCoAuthors(body).body, "why this happened\n\nand a second paragraph");
eq("both trailers come out, case regardless", splitCoAuthors(body).coAuthors, [
  { name: "Ada Lovelace", email: "ada@example.com" },
  { name: "Grace Hopper", email: "grace@example.com" },
]);

// The same person twice - two tools, two spellings of the name - is one
// person, or the editor would show a duplicate the user never typed.
eq(
  "the same email twice is one person",
  splitCoAuthors(
    "Co-authored-by: Ada <ada@example.com>\nCo-authored-by: A. Lovelace <ADA@example.com>",
  ).coAuthors,
  [{ name: "Ada", email: "ada@example.com" }],
);

eq("a body with no trailers is untouched", splitCoAuthors("just a body").body, "just a body");

// --- building the message back --------------------------------------------

// The blank line before the block is what makes them trailers rather than the
// last paragraph of the body.
eq(
  "subject, body, then the trailer block",
  buildMessage("the subject", "the body", [{ name: "Ada", email: "ada@example.com" }]),
  "the subject\n\nthe body\n\nCo-authored-by: Ada <ada@example.com>",
);
eq("no body, still a blank line before the block", buildMessage("subject", "", [
  { name: "Ada", email: "ada@example.com" },
]), "subject\n\nCo-authored-by: Ada <ada@example.com>");
eq("nobody credited, no block", buildMessage("subject", "body", []), "subject\n\nbody");

// A row left half-typed and then abandoned should not become a trailer that
// credits nobody.
eq("an empty row is dropped", buildMessage("subject", "", [{ name: "  ", email: " " }]), "subject");

// The round trip the editor actually performs.
{
  const original = "subject\n\nthe body\n\nCo-authored-by: Ada <ada@example.com>";
  const [first, ...rest] = original.split("\n");
  const split = splitCoAuthors(rest.join("\n"));
  eq("read, split and rebuilt is the same message", buildMessage(first, split.body, split.coAuthors), original);
}

// --- ranking contributors -------------------------------------------------

const commit = (author: string, email: string, coAuthors: Person[] = []): Commit => ({
  hash: author + email,
  parents: [],
  subject: "",
  body: "",
  author,
  email,
  date: 0,
  lane: 0,
  color: 0,
  refs: [],
  coAuthors,
});

const history: Commit[] = [
  commit("Ada", "ada@example.com"),
  commit("Ada", "ada@example.com"),
  commit("Grace", "grace@example.com", [{ name: "Ada", email: "ada@example.com" }]),
  commit("Alan", "alan@example.com"),
];

eq(
  "most active first",
  contributors(history).map((c) => `${c.person.name}:${c.count}`),
  ["Ada:3", "Alan:1", "Grace:1"],
);

// Somebody only ever credited as a co-author is exactly who the picker should
// offer, so trailers count towards the ranking too.
eq(
  "a co-author who never authored still appears",
  contributors([commit("Grace", "grace@example.com", [{ name: "Ada", email: "ada@example.com" }])]).map(
    (c) => c.person.name,
  ),
  ["Ada", "Grace"],
);

// Already credited, or the commit's own author: offering them again is
// offering a duplicate.
eq(
  "the excluded are left out",
  contributors(history, [{ name: "Ada", email: "ADA@example.com" }]).map((c) => c.person.name),
  ["Alan", "Grace"],
);

eq(
  "filtering matches name or email",
  matching(contributors(history), "grace@").map((c) => c.person.name),
  ["Grace"],
);
eq("an empty filter matches everything", matching(contributors(history), "  ").length, 3);

console.log(`
${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
