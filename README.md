<div align="center">

# gitc

<img src="icons/gitc-128.png" width="128" height="128" alt="gitc">

**A fast, minimal git client.**

<img src="https://i.rhythmgamers.net/u/19566122-b616-4cd3-9d3d-af7b573d6a0b.png" alt="gitc showing a repository: the commit graph with branches, tags and authors, the branch tree, and the staging panel">

</div>

## What it is

gitc is a desktop git client written in Rust. It ships as **one native executable** that draws its own window: no browser, no runtime, nothing else to install.

Its first versions were TypeScript compiled to native code by [scriptc](https://scriptc.dev/), with the interface served to a browser window; 1.0 is a complete rewrite in Rust.

## Status

**Early.** gitc is somewhat stable in the sense that it wraps git for write operations. But it's still missing core components.

## Install

Download the file for your system from the
[latest release](https://github.com/Adrriii/gitc/releases/latest) and run it.

| System | File | |
| ------ | ---- | - |
| Windows | `gitc.exe` | double-click it |
| Linux | `gitc` | `chmod +x gitc && ./gitc` |

That is the whole installation. The download **is** gitc: running it copies
itself into place, puts that directory on your `PATH`, installs the icon and
the desktop entry, and then starts the app. Afterwards `gitc` works from any
terminal, and gitc appears in the Start Menu or your application launcher with
its own icon.

To update, download the new file and run it again. To remove it:

```sh
gitc --uninstall
```

Nothing is written outside your own user directories, and nothing needs
administrator or root.

<details>
<summary>Where things go</summary>

| | Windows | Linux |
| - | ------- | ----- |
| Binary | `%LOCALAPPDATA%\Programs\gitc` | `~/.local/bin` |
| Icon | beside the binary | `~/.local/share/icons/hicolor` |
| Launcher entry | Start Menu shortcut | `~/.local/share/applications/gitc.desktop` |
| Settings | `%APPDATA%\gitc` | `~/.config/gitc` |

Run it with `--portable` to skip all of that and just start the app from where
it is.

</details>

## Requirements

- **Windows** or **Linux**
- **git** in the `PATH`

## Building from source

[Rust](https://rustup.rs) stable, nothing else:

```sh
cargo build --release
cargo test
```

The result is `target/release/gitc` (`gitc.exe` on Windows). Run it with a
repository path, or with none to reopen your last session:

```sh
./target/release/gitc /path/to/repo --portable
./target/release/gitc --version
```

`--portable` skips the self-install, which is what you want for a build you
are trying out.

## How it works

| Layer | What it does |
| ----- | ------------ |
| Engine | Rust, in the same process as the window |
| Reads | Parse `.git` directly (refs, HEAD, config and in-progress state) for speed on large repositories |
| Writes | Delegated to the `git` CLI, always. git's own rebase and merge are correct; a reimplementation would not be |
| UI | [egui](https://github.com/emilk/egui), drawn by the GPU |
| Remote repositories | `ssh <host> gitc --stdio`: the gitc on the other machine answers over the ssh channel, nothing listens on a port |

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
