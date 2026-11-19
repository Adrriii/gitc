use std::collections::{HashMap, HashSet};

use crate::engine::types::{Commit, Person};

const TRAILER: &str = "co-authored-by:";
const LABEL: &str = "Co-authored-by: ";

#[derive(Clone, Debug, PartialEq)]
pub struct Contributor {
    pub person: Person,
    pub count: usize,
}

/// Splits `Name <email>` as a trailer spells it, tolerating a missing bracket.
pub fn parse_person(value: &str) -> Option<Person> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    let bare = || Some(Person { name: text.to_string(), email: String::new() });
    let (Some(open), Some(close)) = (text.rfind('<'), text.rfind('>')) else { return bare() };
    if close < open {
        return bare();
    }
    let name = text.get(..open).unwrap_or("").trim();
    let email = text.get(open + 1..close).unwrap_or("").trim();
    let name = if name.is_empty() { email } else { name };
    Some(Person { name: name.to_string(), email: email.to_string() })
}

pub fn format_person(person: &Person) -> String {
    let name = person.name.trim();
    let email = person.email.trim();
    match (name.is_empty(), email.is_empty()) {
        (_, true) => name.to_string(),
        (true, false) => format!("<{email}>"),
        (false, false) => format!("{name} <{email}>"),
    }
}

/// Takes the co-author trailers out of a message body, one entry per person.
pub fn split_co_authors(body: &str) -> (String, Vec<Person>) {
    let mut kept = Vec::new();
    let mut people = Vec::new();
    let mut seen = HashSet::new();
    for line in body.split('\n') {
        let trimmed = line.trim();
        let is_trailer = trimmed.get(..TRAILER.len()).is_some_and(|p| p.eq_ignore_ascii_case(TRAILER));
        if !is_trailer {
            kept.push(line);
            continue;
        }
        let Some(person) = parse_person(trimmed.get(TRAILER.len()..).unwrap_or("")) else { continue };
        if seen.insert(key(&person)) {
            people.push(person);
        }
    }
    (kept.join("\n").trim().to_string(), people)
}

/// The whole message git is given: subject, body, then the trailer block.
pub fn build_message(summary: &str, body: &str, co_authors: &[Person]) -> String {
    let mut parts = vec![summary.trim().to_string()];
    let text = body.trim();
    if !text.is_empty() {
        parts.push(text.to_string());
    }
    let credited: Vec<String> = co_authors
        .iter()
        .filter(|p| !p.name.trim().is_empty() || !p.email.trim().is_empty())
        .map(|p| format!("{LABEL}{}", format_person(p)))
        .collect();
    if !credited.is_empty() {
        parts.push(credited.join("\n"));
    }
    parts.join("\n\n")
}

/// Who commits here, authors and co-authors alike, most active first.
pub fn contributors(commits: &[Commit], exclude: &[Person]) -> Vec<Contributor> {
    let skip: HashSet<String> = exclude.iter().map(key).collect();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Contributor> = Vec::new();
    let mut add = |person: &Person| {
        let id = key(person);
        if id.is_empty() || skip.contains(&id) {
            return;
        }
        if let Some(seen) = index.get(&id).and_then(|&i| out.get_mut(i)) {
            seen.count += 1;
            return;
        }
        index.insert(id, out.len());
        out.push(Contributor { person: person.clone(), count: 1 });
    };
    for c in commits {
        add(&Person { name: c.author.clone(), email: c.email.clone() });
        for p in &c.co_authors {
            add(p);
        }
    }
    out.sort_by(|a, b| {
        b.count.cmp(&a.count).then_with(|| a.person.name.to_lowercase().cmp(&b.person.name.to_lowercase()))
    });
    out
}

/// Filters the picker's list by what has been typed into it.
pub fn matching<'a>(list: &'a [Contributor], query: &str) -> Vec<&'a Contributor> {
    let q = query.trim().to_lowercase();
    list.iter()
        .filter(|c| {
            q.is_empty() || c.person.name.to_lowercase().contains(&q) || c.person.email.to_lowercase().contains(&q)
        })
        .collect()
}

fn key(person: &Person) -> String {
    let email = person.email.trim().to_lowercase();
    if email.is_empty() { person.name.trim().to_lowercase() } else { email }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(name: &str, email: &str) -> Person {
        Person { name: name.into(), email: email.into() }
    }

    fn commit(author: &str, email: &str, co: Vec<Person>) -> Commit {
        Commit {
            hash: format!("{author}{email}"),
            author: author.into(),
            email: email.into(),
            co_authors: co,
            ..Default::default()
        }
    }

    #[test]
    fn parses_people() {
        assert_eq!(parse_person("Ada Lovelace <ada@example.com>"), Some(person("Ada Lovelace", "ada@example.com")));
        assert_eq!(parse_person("Ada Lovelace"), Some(person("Ada Lovelace", "")));
        assert_eq!(parse_person("<ada@example.com>"), Some(person("ada@example.com", "ada@example.com")));
        assert_eq!(parse_person("   "), None);
        assert_eq!(format_person(&person("Ada", "ada@example.com")), "Ada <ada@example.com>");
        assert_eq!(format_person(&person("Ada", "")), "Ada");
    }

    #[test]
    fn splits_trailers() {
        let body = "why this happened\n\nand a second paragraph\n\nCo-authored-by: Ada Lovelace <ada@example.com>\nco-authored-by: Grace Hopper <grace@example.com>";
        let (text, people) = split_co_authors(body);
        assert_eq!(text, "why this happened\n\nand a second paragraph");
        assert_eq!(
            people,
            vec![person("Ada Lovelace", "ada@example.com"), person("Grace Hopper", "grace@example.com")]
        );
        let (_, twice) =
            split_co_authors("Co-authored-by: Ada <ada@example.com>\nCo-authored-by: A. Lovelace <ADA@example.com>");
        assert_eq!(twice, vec![person("Ada", "ada@example.com")]);
        assert_eq!(split_co_authors("just a body").0, "just a body");
    }

    #[test]
    fn builds_messages() {
        let ada = vec![person("Ada", "ada@example.com")];
        assert_eq!(
            build_message("the subject", "the body", &ada),
            "the subject\n\nthe body\n\nCo-authored-by: Ada <ada@example.com>"
        );
        assert_eq!(build_message("subject", "", &ada), "subject\n\nCo-authored-by: Ada <ada@example.com>");
        assert_eq!(build_message("subject", "body", &[]), "subject\n\nbody");
        assert_eq!(build_message("subject", "", &[person("  ", " ")]), "subject");
        let original = "subject\n\nthe body\n\nCo-authored-by: Ada <ada@example.com>";
        let (first, rest) = original.split_once('\n').unwrap_or((original, ""));
        let (body, people) = split_co_authors(rest);
        assert_eq!(build_message(first, &body, &people), original);
    }

    #[test]
    fn ranks_contributors() {
        let ada = person("Ada", "ada@example.com");
        let history = vec![
            commit("Ada", "ada@example.com", vec![]),
            commit("Ada", "ada@example.com", vec![]),
            commit("Grace", "grace@example.com", vec![ada.clone()]),
            commit("Alan", "alan@example.com", vec![]),
        ];
        let ranked: Vec<String> =
            contributors(&history, &[]).iter().map(|c| format!("{}:{}", c.person.name, c.count)).collect();
        assert_eq!(ranked, ["Ada:3", "Alan:1", "Grace:1"]);
        let only_co: Vec<String> = contributors(&[commit("Grace", "grace@example.com", vec![ada])], &[])
            .into_iter()
            .map(|c| c.person.name)
            .collect();
        assert_eq!(only_co, ["Ada", "Grace"]);
        let excluded: Vec<String> =
            contributors(&history, &[person("Ada", "ADA@example.com")]).into_iter().map(|c| c.person.name).collect();
        assert_eq!(excluded, ["Alan", "Grace"]);
        let all = contributors(&history, &[]);
        let found: Vec<&str> = matching(&all, "grace@").iter().map(|c| c.person.name.as_str()).collect();
        assert_eq!(found, ["Grace"]);
        assert_eq!(matching(&all, "  ").len(), 3);
    }
}
