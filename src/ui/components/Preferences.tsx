import { useState } from "react";
import { api } from "../api";
import type { UpdateInfo } from "../types";
import {
  FETCH_INTERVALS,
  TAB_SIZES,
  UPDATE_CHECKS,
  useDiffWrap,
  useFetchInterval,
  useHiddenCommands,
  useTabSize,
  useUpdateCheck,
} from "../settings";
import { PRESETS, TOKEN_GROUPS, useTheme } from "../theme";
import { VERSION } from "../../generated/version";
import { Icon } from "./Icon";
import s from "./Preferences.module.scss";

/**
 * Preferences.
 *
 * A full-window screen rather than a modal, the way the reference does it:
 * settings are a place you go, not a dialog you dismiss, and a modal over the
 * graph would leave the repository visible but untouchable behind it.
 *
 * Everything here takes effect immediately - there is no Apply button and
 * nothing to save. Settings that need a round trip to see are settings people
 * assume are broken.
 */

type Section = "theme" | "editor" | "repository" | "commands" | "about";

const SECTIONS: {
  id: Section;
  label: string;
  icon: "eye" | "edit" | "repo" | "fetch" | "branch";
}[] = [
  { id: "theme", label: "Theme", icon: "eye" },
  { id: "editor", label: "Editor", icon: "edit" },
  { id: "repository", label: "Repository", icon: "fetch" },
  { id: "commands", label: "Command log", icon: "branch" },
  { id: "about", label: "About", icon: "repo" },
];

/** One labelled control. The label column is right-aligned, as in the reference. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={s.row}>
      <div className={s.label}>{label}</div>
      <div className={s.control}>
        {children}
        {hint && <div className={s.hint}>{hint}</div>}
      </div>
    </div>
  );
}

/**
 * The update state belongs to the application, not to this screen.
 *
 * It used to be kept here, which meant checking from this screen told the
 * status bar nothing - and this screen then pointed at a status bar it had
 * itself replaced, for a button that had never been told there was an update.
 * One source, shown in both places.
 */
export function Preferences({
  onClose,
  update,
  checking,
  updating,
  onCheck,
  onUpdate,
}: {
  onClose: () => void;
  update: UpdateInfo | null;
  checking: boolean;
  updating: boolean;
  onCheck: () => void;
  onUpdate: () => void;
}) {
  const [section, setSection] = useState<Section>("theme");
  const { size: tabSize, set: setTabSize } = useTabSize();
  const { wrap, set: setWrap } = useDiffWrap();
  const theme = useTheme();
  const { minutes: fetchMinutes, set: setFetchMinutes } = useFetchInterval();
  const {
    hidden: hiddenCommands,
    show: showCommand,
    showAll: showAllCommands,
  } = useHiddenCommands();
  const { minutes: updateMinutes, set: setUpdateMinutes } = useUpdateCheck();

  return (
    <div className={s.screen}>
      <div className={s.nav}>
        <button className={s.exit} onClick={onClose}>
          <Icon name="chevronRight" size={12} className={s.exitIco} />
          Exit Preferences
        </button>

        <div className={s.navGroup}>Preferences</div>
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            className={`${s.navItem} ${section === entry.id ? s.navOn : ""}`}
            onClick={() => setSection(entry.id)}
          >
            <Icon name={entry.icon} size={14} className={s.navIco} />
            {entry.label}
          </button>
        ))}
      </div>

      <div className={s.pane}>
        {section === "theme" && (
          <>
            <h1>Theme</h1>

            <Row label="Preset" hint="A starting point. Any colour below can be changed on top of it.">
              <div className={s.presets}>
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    className={`${s.preset} ${preset.id === theme.presetId ? s.presetOn : ""}`}
                    onClick={() => theme.choosePreset(preset.id)}
                    title={preset.blurb}
                  >
                    {/* The swatch is the preset painting itself: floor, chrome,
                        accent and three lanes, which is enough to recognise. */}
                    <span
                      className={s.swatch}
                      style={{ background: preset.colors["bg-0"], borderColor: preset.colors.line }}
                    >
                      <span style={{ background: preset.colors["bg-2"] }} />
                      <span style={{ background: preset.colors.accent }} />
                      <span style={{ background: preset.colors["lane-1"] }} />
                      <span style={{ background: preset.colors["lane-2"] }} />
                      <span style={{ background: preset.colors["lane-3"] }} />
                    </span>
                    <span className={s.presetName}>{preset.name}</span>
                  </button>
                ))}
              </div>
            </Row>

            {Object.keys(theme.overrides).length > 0 && (
              <Row label="Customised" hint="Colours you changed on top of the preset.">
                <button className={s.resetAll} onClick={() => theme.reset()}>
                  Reset {Object.keys(theme.overrides).length} to {theme.preset.name}
                </button>
              </Row>
            )}

            {TOKEN_GROUPS.map((group) => (
              <div key={group.title} className={s.group}>
                <h2>{group.title}</h2>
                <p className={s.groupBlurb}>{group.blurb}</p>
                <div className={s.colors}>
                  {group.tokens.map((token) => {
                    const value = theme.colors[token.name];
                    const changed = theme.overrides[token.name] !== undefined;
                    return (
                      <label key={token.name} className={s.color}>
                        <input
                          type="color"
                          value={value}
                          onChange={(e) => theme.setColor(token.name, e.target.value)}
                        />
                        <span className={s.colorText}>
                          <span className={s.colorLabel}>{token.label}</span>
                          <span className={s.colorValue}>{value}</span>
                        </span>
                        {changed && (
                          <button
                            className={s.revert}
                            title={`Back to ${theme.preset.name}`}
                            onClick={(e) => {
                              e.preventDefault();
                              theme.reset(token.name);
                            }}
                          >
                            ↺
                          </button>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}

        {section === "editor" && (
          <>
            <h1>Editor</h1>

            <Row
              label="Tab width"
              hint="How far a tab indents, in characters. Applies to diffs, the file view and the conflict editor."
            >
              <div className={s.choices}>
                {TAB_SIZES.map((n) => (
                  <button
                    key={n}
                    className={n === tabSize ? s.on : ""}
                    onClick={() => setTabSize(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="Long lines" hint="Wrapping keeps everything on screen; scrolling keeps the shape of the code.">
              <div className={s.choices}>
                <button className={wrap ? s.on : ""} onClick={() => setWrap(true)}>
                  Wrap
                </button>
                <button className={!wrap ? s.on : ""} onClick={() => setWrap(false)}>
                  Scroll
                </button>
              </div>
            </Row>
          </>
        )}

        {section === "repository" && (
          <>
            <h1>Repository</h1>
            <Row
              label="Fetch automatically"
              hint="Only the repository you are looking at, and only while the window has focus. The command shows in the ticker like any other."
            >
              <div className={s.choices}>
                {FETCH_INTERVALS.map((n) => (
                  <button
                    key={n}
                    className={n === fetchMinutes ? s.on : ""}
                    onClick={() => setFetchMinutes(n)}
                  >
                    {n === 0 ? "Off" : `${n} min`}
                  </button>
                ))}
              </div>
            </Row>
          </>
        )}

        {section === "commands" && (
          <>
            <h1>Command log</h1>
            <Row
              label="Hidden commands"
              hint={
                hiddenCommands.length === 0
                  ? "Nothing is hidden. The eye on a row in the command log hides every command of that kind - the polls gitc runs constantly are the usual reason."
                  : "These no longer appear in the command log or the ticker. They are still run, and still recorded: showing one again brings its history back."
              }
            >
              {hiddenCommands.length === 0 ? (
                <span className={s.value}>None</span>
              ) : (
                <div className={s.chips}>
                  {hiddenCommands.map((name) => (
                    <button
                      key={name}
                      className={s.chip}
                      onClick={() => showCommand(name)}
                      title={`Show "git ${name}" in the log again`}
                    >
                      <span className={s.chipName}>git {name}</span>
                      <Icon name="close" size={10} />
                    </button>
                  ))}
                  <button className={s.resetAll} onClick={showAllCommands}>
                    Show all
                  </button>
                </div>
              )}
            </Row>
          </>
        )}

        {section === "about" && (
          <>
            <h1>About</h1>
            <Row
              label="Version"
              hint={
                update === null
                  ? undefined
                  : update.available
                    ? `gitc ${update.latest} is available. Updating replaces this copy and restarts.`
                    : update.error.length > 0
                      ? update.error
                      : "This is the newest version."
              }
            >
              <div className={s.versionRow}>
                <span className={s.value}>gitc {VERSION}</span>
                {/*
                  The button that does the thing, next to the answer that said
                  it was possible. Sending someone to look for it elsewhere is
                  how it went unfound.
                */}
                {update !== null && update.available ? (
                  <button className={s.update} disabled={updating} onClick={onUpdate}>
                    {updating ? "Updating…" : `Update to ${update.latest}`}
                  </button>
                ) : (
                  <button className={s.resetAll} disabled={checking} onClick={onCheck}>
                    {checking ? "Checking…" : "Check for updates"}
                  </button>
                )}
              </div>
            </Row>
            <Row
              label="Check for updates"
              hint="An interval checks at launch as well. The check is one request to the releases page and reports nothing unless there is something newer."
            >
              <div className={s.choices}>
                {UPDATE_CHECKS.map((choice) => (
                  <button
                    key={choice.minutes}
                    className={choice.minutes === updateMinutes ? s.on : ""}
                    onClick={() => setUpdateMinutes(choice.minutes)}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="Licence" hint="Free software. The source is the whole program.">
              <span className={s.value}>GNU Affero General Public License v3.0</span>
            </Row>
            <Row
              label="Settings"
              hint="Open repositories and hidden branches live here; preferences on this screen are stored by the window itself."
            >
              <span className={s.value}>
                {navigator.userAgent.includes("Windows") ? "%APPDATA%\\gitc" : "~/.config/gitc"}
              </span>
            </Row>
          </>
        )}
      </div>
    </div>
  );
}
