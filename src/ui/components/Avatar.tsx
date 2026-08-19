import { useEffect, useState } from "react";
import { useAvatarCandidates, initialsOf } from "../avatar";
import s from "./Avatar.module.scss";

/**
 * An author's picture, falling back through each candidate to their initials.
 *
 * Rendered as an <img> rather than a CSS background so a load failure is
 * observable - and failure is the normal path here, not the exception. Most
 * commit authors have no avatar registered anywhere, so most nodes end up on
 * initials, and the component walks the candidate list to find that out.
 */
export function Avatar({
  name,
  email,
  size,
  ringColor,
  rounded,
  className,
}: {
  name: string;
  email: string;
  size: number;
  /** When set, the avatar is circular with a ring in this colour. */
  ringColor?: string;
  /** Square with soft corners, for the detail panel. */
  rounded?: boolean;
  className?: string;
}) {
  const candidates = useAvatarCandidates(email);
  const [index, setIndex] = useState(0);

  // A new candidate list (a different author, or the remote lookup landing)
  // restarts the walk rather than leaving the index pointing into the old one.
  useEffect(() => {
    setIndex(0);
  }, [candidates.join("|")]);

  const src = index < candidates.length ? candidates[index] : null;

  return (
    <span
      className={`${s.avatar} ${rounded ? s.rounded : s.circle} ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        borderColor: ringColor,
        borderWidth: ringColor ? 2 : 0,
      }}
      title={email.length > 0 ? `${name} <${email}>` : name}
    >
      {src !== null ? (
        <img
          className={s.img}
          src={src}
          alt=""
          onError={() => setIndex((i) => i + 1)}
        />
      ) : (
        <span className={s.initials} style={{ fontSize: Math.max(8, Math.round(size * 0.4)) }}>
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}
