/**
 * The `--dsw-*` token stylesheet this settings row injects for exactly the
 * owning plugin's lifetime.
 *
 * A plain string rather than a CSS module: this Bundle builds its browser half
 * with its own tsdown config, which has no CSS pipeline, so a `.module.css`
 * import has nothing to resolve. The sibling `app-notification` Bundle solves
 * the same problem the same way.
 *
 * These values copy the shell's own settings dropdown — `PreferenceRow` in
 * `ui-chat/src/client/settings/PreferenceRow.module.css`, the row shape the
 * General settings use ("工作过程展示", "性能与用量"). Its control is a pill
 * button that opens the shared `Menu`, not a `<select>`: a native select's
 * popup is drawn by the OS and cannot carry the theme, so the checkmarked card
 * in the reference design is only reachable through `Menu`.
 *
 * The `Menu` card itself needs no styles here — it is a `ui-primitives` value
 * import and brings its own sheet (`Menu.module.css`) with it.
 *
 * Class names are prefixed `str-`, so the sheet cannot collide with the shell's.
 */

/** Stylesheet text installed once per plugin lifetime. */
export const TITLE_MODEL_CSS = `
.str-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.str-rowText {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 48px;
}
.str-title {
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.str-desc {
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.str-trigger {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex: none;
  max-width: 240px;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 18px;
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.str-trigger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.str-trigger:disabled {
  opacity: 0.5;
  cursor: default;
}
.str-triggerLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.str-chevron {
  flex: none;
}
.str-notice {
  margin: 0;
  padding: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.str-notice[data-failed='true'] {
  color: var(--dsw-alias-state-error-primary);
}
.str-notice button {
  border: 0;
  padding: 0;
  background: transparent;
  font: inherit;
  color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.str-notice button:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
`
