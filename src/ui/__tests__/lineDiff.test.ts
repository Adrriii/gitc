import { lineDiff } from "../lineDiff.ts";

let pass = 0,
  fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `${ok ? "  ok  " : " FAIL "} ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`,
  );
  ok ? pass++ : fail++;
};

const shape = (before: string[], after: string[]) => {
  const d = lineDiff(before, after);
  return { marks: d.marks, was: [...d.was], removed: [...d.removed] };
};

console.log("lineDiff");
eq("unchanged", shape(["a", "b"], ["a", "b"]), { marks: ["same", "same"], was: [], removed: [] });
eq("one line edited", shape(["a", "b", "c"], ["a", "B", "c"]), {
  marks: ["same", "mod", "same"],
  was: [[1, "b"]],
  removed: [],
});
eq("a line added in the middle", shape(["a", "c"], ["a", "b", "c"]), {
  marks: ["same", "add", "same"],
  was: [],
  removed: [],
});
eq("a line removed in the middle", shape(["a", "b", "c"], ["a", "c"]), {
  marks: ["same", "same"],
  was: [],
  removed: [1],
});
eq("the last line removed", shape(["a", "b"], ["a"]), { marks: ["same"], was: [], removed: [1] });
eq("everything new", shape([], ["x", "y"]), { marks: ["add", "add"], was: [], removed: [] });
eq("two edits apart", shape(["a", "b", "c", "d", "e"], ["a", "B", "c", "D", "e"]), {
  marks: ["same", "mod", "same", "mod", "same"],
  was: [
    [1, "b"],
    [3, "d"],
  ],
  removed: [],
});
eq("one edited and one extra", shape(["a", "b", "c"], ["a", "B", "x", "c"]), {
  marks: ["same", "mod", "add", "same"],
  was: [[1, "b"]],
  removed: [],
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
