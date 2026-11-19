use std::sync::OnceLock;

use eframe::egui::Color32;
use eframe::egui::text::{LayoutJob, TextFormat};
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};

use crate::ui::theme::Palette;

/// The palette's syntax tokens; the colour is looked up at paint time so a theme change needs no re-highlight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Syn {
    Plain,
    Keyword,
    Type,
    Number,
    String,
    Regexp,
    Title,
    Variable,
    Comment,
    Doctag,
    Meta,
    Tag,
    Punct,
}

/// A coloured byte range of one line. Gaps between tokens are `Syn::Plain`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Token {
    pub start: usize,
    pub end: usize,
    pub syn: Syn,
}

/// Above this many bytes in one document, highlighting is skipped.
pub const MAX_CHARS: usize = 2 * 1024 * 1024;
const MAX_LINE: usize = 4000;

impl Syn {
    pub fn color(self, p: &Palette) -> Color32 {
        match self {
            Syn::Plain => p.fg,
            Syn::Keyword => p.syn_keyword,
            Syn::Type => p.syn_type,
            Syn::Number => p.syn_number,
            Syn::String => p.syn_string,
            Syn::Regexp => p.syn_regexp,
            Syn::Title => p.syn_title,
            Syn::Variable => p.syn_variable,
            Syn::Comment => p.syn_comment,
            Syn::Doctag => p.syn_doctag,
            Syn::Meta => p.syn_meta,
            Syn::Tag => p.syn_tag,
            Syn::Punct => p.syn_punct,
        }
    }
}

/// True when `path` names a language the highlighter knows.
pub fn supported(path: &str) -> bool {
    syntax_for(path).is_some()
}

/// Tokens for each of `lines`, parsed as one document so constructs spanning lines colour correctly.
/// Every line gets an empty list when the language is unknown or the text is over `MAX_CHARS`.
pub fn tokens(path: &str, lines: &[&str]) -> Vec<Vec<Token>> {
    let plain = || vec![Vec::new(); lines.len()];
    let Some(syntax) = syntax_for(path) else { return plain() };
    if lines.iter().map(|l| l.len() + 1).sum::<usize>() > MAX_CHARS {
        return plain();
    }
    let set = syntax_set();
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut buf = String::new();
    lines
        .iter()
        .map(|line| {
            if line.len() > MAX_LINE {
                return Vec::new();
            }
            buf.clear();
            buf.push_str(line);
            buf.push('\n');
            let Ok(ops) = state.parse_line(&buf, set) else { return Vec::new() };
            let mut out = Vec::new();
            let mut at = 0;
            for (pos, op) in ops {
                let pos = pos.min(line.len());
                if pos > at {
                    push(&mut out, at, pos, classify(&stack));
                    at = pos;
                }
                let _ = stack.apply(&op);
            }
            if line.len() > at {
                push(&mut out, at, line.len(), classify(&stack));
            }
            out
        })
        .collect()
}

/// Appends `line` to `job` in `base`'s format, recoloured by `toks`.
pub fn append(job: &mut LayoutJob, line: &str, toks: &[Token], palette: &Palette, base: &TextFormat) {
    let mut at = 0;
    let piece = |job: &mut LayoutJob, start: usize, end: usize, syn: Syn| {
        let Some(text) = line.get(start..end) else { return };
        if text.is_empty() {
            return;
        }
        let mut format = base.clone();
        if syn != Syn::Plain {
            format.color = syn.color(palette);
        }
        format.italics = syn == Syn::Comment;
        job.append(text, 0.0, format);
    };
    for t in toks {
        if t.start > at {
            piece(job, at, t.start, Syn::Plain);
        }
        piece(job, t.start.max(at), t.end, t.syn);
        at = at.max(t.end);
    }
    if line.len() > at {
        piece(job, at, line.len(), Syn::Plain);
    }
}

fn push(out: &mut Vec<Token>, start: usize, end: usize, syn: Syn) {
    if syn == Syn::Plain {
        return;
    }
    if let Some(last) = out.last_mut()
        && last.end == start
        && last.syn == syn
    {
        last.end = end;
        return;
    }
    out.push(Token { start, end, syn });
}

fn classify(stack: &ScopeStack) -> Syn {
    let rules = rules();
    for scope in stack.as_slice().iter().rev() {
        if let Some((_, syn)) = rules.iter().find(|(prefix, _)| prefix.is_prefix_of(*scope)) {
            return *syn;
        }
    }
    Syn::Plain
}

fn rules() -> &'static [(Scope, Syn)] {
    static RULES: OnceLock<Vec<(Scope, Syn)>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            ("comment.block.documentation", Syn::Comment),
            ("storage.type.class.jsdoc", Syn::Doctag),
            ("keyword.other.documentation", Syn::Doctag),
            ("comment", Syn::Comment),
            ("string.regexp", Syn::Regexp),
            ("string", Syn::String),
            ("constant.character.escape", Syn::String),
            ("constant.numeric", Syn::Number),
            ("constant.language", Syn::Keyword),
            ("keyword.operator", Syn::Plain),
            ("keyword", Syn::Keyword),
            ("storage", Syn::Keyword),
            ("support.type.property-name", Syn::Variable),
            ("entity.name.function", Syn::Title),
            ("support.function", Syn::Title),
            ("variable.function", Syn::Title),
            ("entity.name.type", Syn::Type),
            ("entity.name.class", Syn::Type),
            ("entity.name.struct", Syn::Type),
            ("entity.name.enum", Syn::Type),
            ("entity.name.trait", Syn::Type),
            ("entity.name.interface", Syn::Type),
            ("entity.other.inherited-class", Syn::Type),
            ("support.type", Syn::Type),
            ("support.class", Syn::Type),
            ("entity.name.tag", Syn::Keyword),
            ("entity.name.section", Syn::Title),
            ("markup.heading", Syn::Title),
            ("entity.other.attribute-name", Syn::Variable),
            ("variable.language", Syn::Keyword),
            ("variable", Syn::Variable),
            ("meta.preprocessor", Syn::Meta),
            ("meta.annotation", Syn::Meta),
            ("meta.attribute", Syn::Meta),
            ("punctuation.definition.tag", Syn::Tag),
            ("markup.list", Syn::Punct),
            ("markup.underline.link", Syn::Keyword),
            ("markup.raw", Syn::String),
        ]
        .into_iter()
        .filter_map(|(name, syn)| Scope::new(name).ok().map(|s| (s, syn)))
        .collect()
    })
}

fn syntax_set() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn syntax_for(path: &str) -> Option<&'static SyntaxReference> {
    let file = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let bare = file.trim_start_matches('.');
    let ext = match by_name(bare) {
        Some(ext) => ext,
        None => {
            let (_, ext) = file.rsplit_once('.')?;
            alias(ext).unwrap_or(ext)
        }
    };
    let syntax = syntax_set().find_syntax_by_extension(ext)?;
    (syntax.name != "Plain Text").then_some(syntax)
}

fn by_name(name: &str) -> Option<&'static str> {
    Some(match name {
        "makefile" | "gnumakefile" => "mk",
        "gemfile" | "rakefile" | "podfile" | "vagrantfile" | "brewfile" => "rb",
        "bashrc" | "zshrc" | "profile" | "env" => "sh",
        _ => return None,
    })
}

// ponytail: syntect's bundled set has no TypeScript, TOML, PowerShell or Dockerfile grammar; TS borrows the
// JavaScript one. Load extra .sublime-syntax files into the set if those matter.
fn alias(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "ts" | "tsx" | "mts" | "cts" | "jsx" | "mjs" | "cjs" => "js",
        "vue" | "svelte" | "xaml" | "csproj" | "props" | "targets" | "resx" | "plist" | "svg" => "xml",
        "htm" | "cshtml" | "razor" => "html",
        "hpp" | "hh" | "cc" | "cxx" | "metal" => "cpp",
        "cl" => "c",
        "ipynb" | "jsonc" | "json5" | "babelrc" | "eslintrc" => "json",
        "zsh" | "fish" | "bash" => "sh",
        "cmd" => "bat",
        "mdx" => "md",
        "pyi" | "ipy" => "py",
        "rake" | "gemspec" | "podspec" => "rb",
        "scss" | "sass" | "less" | "styl" => "css",
        "gradle" => "groovy",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_resolve_from_names_and_extensions() {
        assert!(supported("src/main.rs"));
        assert!(supported("old/src/ui/App.tsx"));
        assert!(supported("Makefile"));
        assert!(!supported("notes.txt"));
        assert!(!supported("LICENSE"));
    }

    #[test]
    fn a_block_comment_spanning_lines_stays_a_comment() {
        let lines = ["let a = 1; /* open", "still comment", "close */ let b = 2;"];
        let toks = tokens("x.js", &lines);
        assert_eq!(toks.len(), 3);
        let middle = toks.get(1).cloned().unwrap_or_default();
        assert_eq!(middle, vec![Token { start: 0, end: "still comment".len(), syn: Syn::Comment }]);
        let first = toks.first().cloned().unwrap_or_default();
        assert!(first.iter().any(|t| t.syn == Syn::Keyword));
    }

    #[test]
    fn unknown_languages_give_empty_lines() {
        assert_eq!(tokens("a.unknownext", &["x", "y"]), vec![Vec::new(), Vec::new()]);
    }
}
