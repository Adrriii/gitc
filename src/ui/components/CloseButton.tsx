import type { MouseEvent } from "react";

import { Icon } from "./Icon";
import s from "./CloseButton.module.scss";

/**
 * The cross that closes something: a repository tab, a diff, the merge editor,
 * a toast.
 *
 * A component rather than a convention, because the convention did not hold -
 * five components had grown their own `.close`, in four different greys and
 * three sizes. Anything a call site legitimately varies is a prop; anything it
 * does not is in here.
 *
 * `className` is for placement only - where the button sits, and whether it is
 * visible at all. Its colour, its box and its hover belong to the shared rule,
 * and a call site that restyles those is the drift starting again.
 */
export function CloseButton({
  onClick,
  title,
  size = 12,
  className,
}: {
  /**
   * Takes the event, because a cross inside something clickable - a repository
   * tab - has to stop the click reaching it, or closing the tab activates it
   * on the way out.
   */
  onClick: (e: MouseEvent) => void;
  title?: string;
  /** The cross itself; the button around it is one size everywhere. */
  size?: number;
  /** Placement and visibility, never colour. */
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className === undefined ? s.close : `${s.close} ${className}`}
      onClick={onClick}
      title={title}
    >
      <Icon name="close" size={size} />
    </button>
  );
}
