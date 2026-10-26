import { memo } from "react";

/**
 * Highlighted markup for one line, written into the DOM only when it changes.
 *
 * React 19 compares dangerouslySetInnerHTML by the object, not the string in
 * it, so a fresh `{ __html }` on every render rewrote every line - a refresh
 * of the same diff included - and a text selection went with the old nodes.
 */
export const Html = memo(function Html({ className, html }: { className: string; html: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});
