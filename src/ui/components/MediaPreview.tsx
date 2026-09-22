import { useEffect, useState } from "react";
import { api } from "../api";
import { formatBytes, mediaSides, type MediaKind } from "../media";
import type { DiffTarget } from "./DiffView";
import s from "./MediaPreview.module.scss";

/**
 * An image, video or audio file shown as itself rather than as "binary".
 *
 * Before and after side by side for a change, one pane for a file that was
 * added or deleted - the deleted one is exactly the case where seeing what
 * went is the whole question.
 *
 * The bytes arrive as octet-stream and are wrapped in a Blob typed from the
 * file name (see media.ts), then only ever placed in <img>, <video> or
 * <audio>. A blob: URL belongs to this page, dies with it, and is revoked as
 * soon as the pane lets go of it.
 */
export function MediaPreview({
  tabId,
  target,
  path,
  oldPath,
  status,
  kind,
  type,
  version,
}: {
  tabId: string;
  target: DiffTarget;
  path: string;
  oldPath: string | null;
  status: string;
  kind: MediaKind;
  type: string;
  version?: number;
}) {
  const sides = mediaSides(status);
  return (
    <div className={s.wrap}>
      {sides.map((side) => (
        <Pane
          key={side}
          label={
            sides.length === 1
              ? side === "old"
                ? "Deleted"
                : "Added"
              : side === "old"
                ? "Before"
                : "After"
          }
          tabId={tabId}
          target={target}
          path={path}
          oldPath={oldPath}
          side={side}
          kind={kind}
          type={type}
          version={version}
        />
      ))}
    </div>
  );
}

function Pane({
  label,
  tabId,
  target,
  path,
  oldPath,
  side,
  kind,
  type,
  version,
}: {
  label: string;
  tabId: string;
  target: DiffTarget;
  path: string;
  oldPath: string | null;
  side: "old" | "new";
  kind: MediaKind;
  type: string;
  version?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  const identity = tabId + "|" + path + "|" + side + "|" + JSON.stringify(target);

  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setError(null);
    setBroken(false);
    api
      .media(tabId, target, path, oldPath, side)
      .then((bytes) => {
        if (!live) return;
        made = URL.createObjectURL(new Blob([bytes], { type }));
        setUrl(made);
        setSize(bytes.byteLength);
      })
      .catch((e: Error) => {
        if (!live) return;
        setUrl(null);
        setError(e.message);
      });
    return () => {
      live = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [identity, version]);

  return (
    <div className={s.pane}>
      <div className={s.head}>
        <span className={`${s.label} ${side === "old" ? s.old : s.new}`}>{label}</span>
        {url !== null && (
          <span className={s.meta}>
            {dims !== null ? `${dims} · ` : ""}
            {formatBytes(size)}
          </span>
        )}
      </div>
      <div className={`${s.stage} ${kind === "image" ? s.checker : ""}`}>
        {error !== null ? (
          <div className={s.note}>{error}</div>
        ) : url === null ? (
          <div className={s.note}>Loading…</div>
        ) : broken ? (
          <div className={s.note}>This file could not be shown - it may not be the format its name says.</div>
        ) : kind === "image" ? (
          <img
            className={s.media}
            src={url}
            alt={label}
            draggable={false}
            onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
            onError={() => setBroken(true)}
          />
        ) : kind === "video" ? (
          <video
            className={s.media}
            src={url}
            controls
            preload="metadata"
            onLoadedMetadata={(e) =>
              setDims(`${e.currentTarget.videoWidth} × ${e.currentTarget.videoHeight}`)
            }
            onError={() => setBroken(true)}
          />
        ) : (
          <audio src={url} controls preload="metadata" onError={() => setBroken(true)} />
        )}
      </div>
    </div>
  );
}
