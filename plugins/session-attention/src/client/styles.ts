/**
 * The `--dsw-*` token stylesheet the overlay entry injects for the owning
 * plugin's lifetime.
 *
 * A plain string rather than a CSS module: this package builds its browser
 * bundle with its own tsdown config (no CSS pipeline). Only layout and surface
 * chrome live here; the running/finished-unread indicators come from
 * `ui-primitives` (`StateDot`), so no state color is hand-picked. Class names
 * are prefixed `sa-` to avoid colliding with the shell's styles.
 *
 * `--dsw-elevation-panel` already draws the 0.5px hairline inside the shadow —
 * ui-theme pairs it with `border: 0` — so neither floating surface here
 * declares a border: one beside the shadow double-draws the shape and shifts
 * layout by its width.
 *
 * `.sa-root` restates `pointer-events: none`: ui-layout's overlay layer makes
 * every direct child hit-testable (`.overlayLayer > * { pointer-events: auto }`),
 * and a full-bleed wrapper must not swallow the app's clicks. The doubled class
 * wins on specificity rather than on stylesheet insertion order.
 */

/** Stylesheet text installed once per plugin lifetime. */
export const OVERLAY_CSS = `
.sa-root.sa-root {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.sa-trigger {
  position: absolute;
  right: 16px;
  bottom: 16px;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border-radius: var(--dsw-radius-md);
  box-shadow: var(--dsw-elevation-panel);
  cursor: pointer;
}
.sa-trigger:hover { background: var(--dsw-alias-bg-layer-3); }
.sa-trigger:focus-visible,
.sa-close:focus-visible,
.sa-row:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.sa-badge {
  min-width: 16px;
  padding: 0 4px;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  color: var(--dsw-alias-bg-layer-3);
  background: var(--dsw-alias-label-primary);
  border-radius: 8px;
}
.sa-panel {
  position: absolute;
  right: 16px;
  bottom: 60px;
  display: flex;
  flex-direction: column;
  width: min(320px, calc(100vw - 32px));
  max-height: min(60vh, 480px);
  pointer-events: auto;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: var(--dsw-radius-lg);
  box-shadow: var(--dsw-elevation-panel);
  overflow: hidden;
}
.sa-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.sa-title { font-size: 13px; font-weight: 500; }
.sa-close {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  color: var(--dsw-alias-label-secondary);
  background: none;
  border: none;
  border-radius: var(--dsw-radius-md);
  cursor: pointer;
}
.sa-close:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); }
.sa-body { overflow: auto; padding: 4px 0 6px; }
.sa-section-title {
  margin: 8px 12px 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
}
.sa-list { margin: 0; padding: 0; list-style: none; }
.sa-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: inherit;
  background: none;
  border: none;
  cursor: pointer;
}
.sa-row:hover { background: var(--dsw-alias-bg-layer-3); }
.sa-row-title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sa-empty {
  margin: 0;
  padding: 16px 12px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
`
