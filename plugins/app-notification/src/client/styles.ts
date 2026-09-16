/**
 * The `--dsw-*` token stylesheet the settings row injects for exactly the
 * owning plugin's lifetime. A plain string rather than a CSS module: this
 * package builds its browser bundle with its own tsdown config (no CSS
 * pipeline), and the row is the only styled surface it owns.
 *
 * Only LAYOUT lives here. Controls come from `ui-primitives` (the one package
 * allowed to own a shared control), so no button/hover/disabled chrome is
 * restated here and no color is ever hand-picked.
 *
 * Class names are prefixed `ab-`, so the sheet cannot collide with the shell's
 * styles.
 */

/** Stylesheet text installed once per plugin lifetime. */
export const SETTINGS_ROW_CSS = `
.ab-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.ab-head { display: flex; flex-direction: column; gap: 4px; padding-right: 48px; }
.ab-title { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
.ab-desc { font-size: 12px; font-weight: 400; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.ab-facts { display: flex; flex-direction: column; gap: 4px; margin: 0; }
.ab-fact { display: flex; align-items: baseline; gap: 8px; font-size: 12px; line-height: 18px; }
.ab-fact dt { color: var(--dsw-alias-label-tertiary); }
.ab-fact dd { margin: 0; color: var(--dsw-alias-label-secondary); }
.ab-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ab-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.ab-status[data-failed='true'] { color: var(--dsw-alias-state-error-primary); }
.ab-status[data-success='true'] { color: var(--dsw-alias-state-success-primary); }
`
