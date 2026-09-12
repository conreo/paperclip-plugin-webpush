/**
 * Styles for the plugin UI.
 *
 * The plugin may not import the host's components, and Tailwind only generates the
 * classes the host's own sources use, so utility class names would do nothing here.
 * These rules reproduce the primitives the host's Company Settings page is built
 * from — its `Field`/`ToggleField` rows, `ToggleSwitch`, and `Button` variants — from
 * the same source values, including the states inline styles cannot express: hover,
 * focus rings, disabled, and the dark-mode switch thumb.
 *
 * Reference values, all read from the host sources:
 *   page      `max-w-6xl space-y-8`
 *   header    `flex items-center gap-2` + `h-5 w-5 text-muted-foreground` + `text-lg font-semibold`
 *   section   `max-w-2xl space-y-4` + controls `space-y-3`
 *   label     `text-xs font-medium text-muted-foreground uppercase tracking-wide`
 *   field     label `text-xs text-muted-foreground` with `mb-1`, then the control
 *   input     `w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none`
 *   button    `size="sm"` → `h-9 rounded-md gap-1.5 px-3`, variants default/outline/destructive
 *   switch    `h-5 w-11 border-2 rounded-full`, on-state `--status-task-done`, thumb `h-4 w-6 translate-x-4`
 *   danger    label `text-xs text-destructive uppercase tracking-wide`, block `bg-destructive/5 px-4 py-4`
 */
const STYLE_ELEMENT_ID = "paperclip-webpush-styles";

export const PLUGIN_STYLES = `
.pcp-page { display: grid; gap: 2rem; max-width: 72rem; }
.pcp-header { display: flex; align-items: center; gap: 0.5rem; }
.pcp-header svg { width: 1.25rem; height: 1.25rem; color: var(--muted-foreground); }
.pcp-header h1 { margin: 0; font-size: 1.125rem; line-height: 1.75rem; font-weight: 600; }

.pcp-section { display: grid; gap: 1rem; max-width: 42rem; }
.pcp-section-label {
  font-size: 0.75rem; line-height: 1rem; font-weight: 500; letter-spacing: 0.025em;
  text-transform: uppercase; color: var(--muted-foreground);
}
.pcp-section-label-danger {
  font-size: 0.75rem; line-height: 1rem; letter-spacing: 0.025em;
  text-transform: uppercase; color: var(--destructive);
}
.pcp-stack { display: grid; gap: 0.75rem; }
.pcp-group { display: grid; gap: 0.5rem; }
.pcp-field { display: block; }
.pcp-field-label {
  display: block; margin-bottom: 0.25rem;
  font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground);
}
.pcp-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.pcp-toggle-label {
  display: flex; align-items: center; gap: 0.375rem;
  font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground);
}
.pcp-actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }

.pcp-card {
  display: grid; gap: 0.75rem;
  padding: 1.5rem;
  background: var(--card); color: var(--card-foreground);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
}
.pcp-danger {
  display: grid; gap: 0.75rem;
  padding: 1rem;
  background: color-mix(in oklab, var(--destructive) 5%, transparent);
}
.pcp-hint { margin: 0; font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground); }
.pcp-note { margin: 0; font-size: 0.875rem; line-height: 1.25rem; color: var(--muted-foreground); }
.pcp-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground);
}
.pcp-strong { color: var(--foreground); font-weight: 600; }
.pcp-error { font-size: 0.75rem; line-height: 1rem; color: var(--destructive); white-space: pre-wrap; }
.pcp-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }

.pcp-input {
  width: 100%; min-width: 0;
  padding: 0.375rem 0.625rem;
  font-family: inherit; font-size: 0.875rem; line-height: 1.25rem; color: var(--foreground);
  background: transparent;
  border: 1px solid var(--border); border-radius: var(--radius-md);
  outline: none;
  transition: border-color 120ms, box-shadow 120ms;
}
.pcp-input::placeholder { color: var(--muted-foreground); }
.pcp-input:focus-visible {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}
.pcp-input:disabled { cursor: not-allowed; opacity: 0.5; }

.pcp-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.375rem;
  height: 2.25rem; padding: 0 0.75rem; flex-shrink: 0;
  font-family: inherit; font-size: 0.875rem; line-height: 1.25rem; font-weight: 500; white-space: nowrap;
  background: var(--primary); color: var(--primary-foreground);
  border: 1px solid transparent; border-radius: var(--radius-md);
  cursor: pointer;
  outline: none;
  transition: background-color 120ms, border-color 120ms, opacity 120ms;
}
.pcp-btn:hover { background: color-mix(in oklab, var(--primary) 90%, transparent); }
.pcp-btn:focus-visible {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}
.pcp-btn:disabled { pointer-events: none; opacity: 0.5; }

.pcp-btn-outline {
  background: var(--background); color: var(--foreground);
  border-color: var(--border);
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
}
.pcp-btn-outline:hover { background: var(--accent); color: var(--accent-foreground); }
.pcp-btn-destructive { background: var(--destructive); color: #fff; }
.pcp-btn-destructive:hover {
  background: color-mix(in oklab, var(--destructive) 90%, transparent);
}
.pcp-btn-destructive:focus-visible {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent);
}
.pcp-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.25rem; height: 2.25rem; padding: 0;
  background: transparent; color: inherit;
  border: 1px solid transparent; border-radius: var(--radius-md);
  cursor: pointer; outline: none;
  transition: background-color 120ms, color 120ms;
}
.pcp-icon-btn:hover { background: var(--accent); color: var(--accent-foreground); }
.pcp-icon-btn:focus-visible {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}

/* The host's ToggleSwitch: a capsule with an oblong thumb, green when on. */
.pcp-switch {
  position: relative; display: inline-flex; flex-shrink: 0; align-items: center;
  width: 2.75rem; height: 1.25rem;
  padding: 0;
  border: 2px solid transparent; border-radius: 9999px;
  background: color-mix(in oklab, var(--input) 90%, transparent);
  cursor: pointer; outline: none;
  transition: background-color 120ms, border-color 120ms;
}
.pcp-switch[aria-checked="true"] {
  border-color: var(--status-task-done);
  background: var(--status-task-done);
}
.pcp-switch:disabled { cursor: not-allowed; opacity: 0.5; }
.pcp-switch:focus-visible {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 30%, transparent);
}
.pcp-switch-thumb {
  display: inline-block; pointer-events: none;
  width: 1.5rem; height: 1rem;
  border-radius: 9999px;
  background: var(--background);
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.1);
  transition: translate 140ms ease;
  translate: 0 0;
}
.pcp-switch[aria-checked="true"] .pcp-switch-thumb { translate: 1rem 0; }
.dark .pcp-switch-thumb { background: var(--foreground); }
`;

/**
 * Inject the stylesheet once per document.
 *
 * Keyed by element id so several mounts (the settings page and the toolbar
 * button both call this) do not stack duplicate sheets.
 */
export function usePluginStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = PLUGIN_STYLES;
  document.head.appendChild(style);
}
