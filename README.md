<div align="center">

# gitc

*git + scriptc*

<img src="icons/gitc-128.png" width="128" height="128" alt="gitc">

**A fast, minimal git client.**

</div>

## What it is

gitc is a desktop git client stemming from experimenting with [scriptc](https://scriptc.dev/), an actual Typescript compiler to native code.

It ships as **one executable, around 2 MB**. The engine is TypeScript compiled to native code, and the interface is served to a chromeless browser window on localhost.

Its initial version has been made overnight with Claude Opus 4.8.

## Status

**Early.** gitc is somewhat stable in the sense that it wraps git for write operations. But it's still missing core components.

## Requirements

- **Windows** or **Linux**
- **git** in the `PATH`
- a **Chromium-based browser** (Edge, Chrome, or Chromium) for the display

## Building from source

You need [Node 24+](https://nodejs.org) and `clang` to build, plus
[`zig`](https://ziglang.org) on Windows.

```sh
npm install
npm run build      # typecheck, test, bundle the UI, then compile the binary
```

The result is `dist/gitc.exe` (or `dist/gitc`). Run it with a repository path,
or with none to reopen your last session:

```sh
./dist/gitc /path/to/repo
./dist/gitc --version
```

For development, `npm run dev` starts the engine and a Vite dev server with hot
reloading:

```sh
npm run dev
```

## How it works

| Layer | What it does |
| ----- | ------------ |
| Engine | TypeScript compiled to a native binary, serving a small HTTP API on localhost |
| Reads | Parse `.git` directly — refs, HEAD, config and in-progress state — for speed on large repositories |
| Writes | Delegated to the `git` CLI, always. git's own rebase and merge are correct; a reimplementation would not be |
| UI | React, bundled by Vite and baked into the binary, rendered in a chromeless browser window |

Because the UI is served over localhost rather than embedded in a native
window, gitc has no windowing toolkit to ship and no browser to bundle — it
borrows the one already on your machine.

## Licence

gitc is free software, licensed under the
**[GNU Affero General Public License v3.0](LICENSE)**.

In short: you may use, study, modify and redistribute it, provided that
derivative works remain under the same licence and that anyone you give the
software to — including over a network — can get the source.

## Inspirations

gitc's shape owes a lot to the graph-first git clients that came before it,
[GitKraken](https://www.gitkraken.com/) above all: the commit graph as the
centre of the window, refs as chips on the rows they point at, and conflicts
presented as an editable outcome rather than an error, are all ideas it got
right. gitc is an independent implementation and shares no code with it.

Also owed: [Sublime Merge](https://www.sublimemerge.com/) for showing how fast
a git client is allowed to feel, and [lazygit](https://github.com/jesseduffield/lazygit)
for the reminder that most of a git workflow is a handful of operations you
repeat all day.
