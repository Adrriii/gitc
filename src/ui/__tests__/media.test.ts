import { absolutePath, formatBytes, mediaFor, mediaSides } from "../media.ts";

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

eq("a png is an image", mediaFor("icons/app.png"), { kind: "image", type: "image/png" });
eq("the extension is not case sensitive", mediaFor("SHOT.JPG")?.type, "image/jpeg");
eq("a video", mediaFor("docs/demo.webm")?.kind, "video");
eq("audio", mediaFor("a/b/c.mp3")?.kind, "audio");

// The one image format that can carry script, and git diffs it as text anyway.
eq("svg is not previewed", mediaFor("logo.svg"), null);
eq("text is not previewed", mediaFor("src/main.ts"), null);
eq("no extension", mediaFor("Makefile"), null);
eq("a dotfile has no extension", mediaFor(".png"), null);
eq("a dot in a folder is not an extension", mediaFor("v1.png/readme"), null);
eq("only the last extension counts", mediaFor("shot.png.txt"), null);

eq("added: only after", mediaSides("A"), ["new"]);
eq("deleted: only before", mediaSides("D"), ["old"]);
eq("modified: both", mediaSides("M"), ["old", "new"]);
eq("renamed: both", mediaSides("R"), ["old", "new"]);

eq("bytes", formatBytes(512), "512 B");
eq("kilobytes", formatBytes(1536), "1.5 KB");
eq("megabytes", formatBytes(5 * 1024 * 1024), "5.0 MB");

eq(
  "a Windows repository gets backslashes",
  absolutePath("C:\\Code\\gitc", "src/ui/a.png"),
  "C:\\Code\\gitc\\src\\ui\\a.png",
);
eq("a POSIX repository keeps slashes", absolutePath("/home/a/repo", "src/a.png"), "/home/a/repo/src/a.png");
eq("a trailing separator is not doubled", absolutePath("/home/a/repo/", "x"), "/home/a/repo/x");

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
process.exitCode = fail === 0 ? 0 : 1;
