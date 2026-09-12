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

/*
 * The question mark beside a label, matching the host's hint affordance: a 12px mark
 * opacity that darkens on hover, opening the explanation in a bubble.
 *
 * It is marked as an icon button because of the host's touch rule: under
 * (pointer: coarse) every button is given a 44px floor, which is right for a
 * lone action and wrong for a mark that sits inline with 12px text — the host
 * exempts its own inline widgets the same way.
 */
.pcp-help {
  display: inline-flex; align-items: center; justify-content: center;
  width: 0.875rem; height: 0.875rem; padding: 0;
  border: 0; border-radius: 9999px;
  background: transparent;
  color: color-mix(in oklab, var(--muted-foreground) 50%, transparent);
  cursor: pointer;
  transition: color 120ms;
}
.pcp-help:hover, .pcp-help[aria-expanded="true"] { color: var(--muted-foreground); }
.pcp-help svg { width: 0.75rem; height: 0.75rem; }
.pcp-help-bubble {
  position: absolute; z-index: 30; top: calc(100% + 0.375rem); left: 0;
  width: max-content; max-width: 18rem;
  padding: 0.375rem 0.5rem;
  background: var(--popover, var(--card));
  color: var(--popover-foreground, var(--card-foreground));
  border: 1px solid var(--border); border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.14);
  font-size: 0.75rem; line-height: 1rem; font-weight: 400;
  text-align: left; white-space: normal;
}
.pcp-help-wrap { position: relative; display: inline-flex; align-items: center; }
.pcp-actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }

.pcp-card {
  display: grid; gap: 0.75rem;
  padding: 1.5rem;
  background: var(--card); color: var(--card-foreground);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
}
.pcp-hint { margin: 0; font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground); }
.pcp-note { margin: 0; font-size: 0.875rem; line-height: 1.25rem; color: var(--muted-foreground); }
.pcp-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground);
}
.pcp-error { font-size: 0.75rem; line-height: 1rem; color: var(--destructive); white-space: pre-wrap; }
.pcp-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }

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
  /* The host's own switch is a button with no cursor class, so it shows the default
     arrow; its transitions are Tailwind's transition-all defaults. Both are copied
     rather than improved on, because this control is meant to be indistinguishable
     from the host's. */
  cursor: default; outline: none;
  transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.pcp-switch[aria-checked="true"] {
  border-color: var(--status-task-done);
  background: var(--status-task-done);
}
.pcp-switch:disabled { cursor: not-allowed; opacity: 0.5; }
.pcp-switch:not(:disabled):hover { border-color: transparent; }
.pcp-switch:focus-visible {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 30%, transparent);
}
.pcp-switch-thumb {
  display: inline-block; pointer-events: none;
  width: 1.5rem; height: 1rem;
  border-radius: 9999px;
  background: var(--background);
  /* Tailwind v4's shadow-sm is two layers, and not-dark:bg-clip-padding clips the
     background to the padding box. */
  background-clip: padding-box;
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  /* Tailwind v4's transition-transform covers all four individual transform
     properties, not just the one that moves the thumb today. */
  transition:
    transform 150ms cubic-bezier(0.4, 0, 0.2, 1),
    translate 150ms cubic-bezier(0.4, 0, 0.2, 1),
    scale 150ms cubic-bezier(0.4, 0, 0.2, 1),
    rotate 150ms cubic-bezier(0.4, 0, 0.2, 1);
  translate: 0 0;
}
.pcp-switch[aria-checked="true"] .pcp-switch-thumb { translate: 1rem 0; }
.dark .pcp-switch-thumb { background: var(--foreground); }

.pcp-trigger { display: grid; border-top: 1px solid var(--border); }
.pcp-trigger:first-of-type { border-top: 0; }
.pcp-trigger > .pcp-toggle-row { padding: 0.5rem 0.25rem; }
/* A dot, not the word "Customised": the state is a detail, and the row is a row. */
.pcp-dot {
  flex: 0 0 auto;
  width: 0.375rem; height: 0.375rem;
  border-radius: 9999px;
  background: var(--primary);
}
.pcp-chevron {
  width: 1rem; height: 1rem; color: var(--muted-foreground);
  transition: rotate 140ms ease; rotate: 0deg;
}
.pcp-chevron[data-open="true"] { rotate: 180deg; }

.pcp-trigger-body { display: grid; gap: 0.75rem; padding: 0 0.5rem 0.875rem; }

/*
 * The preview is drawn as the thing it will become. Two lines of muted text under
 * a heading read as help text, and a title at the same size and weight as the
 * field labels above it read as a third label — which is how "Northwind · Approval
 * needed" and the body below it came out as one sentence.
 */
.pcp-notification {
  display: grid; gap: 0.375rem;
  width: min(24rem, 100%);
  padding: 0.75rem;
  background: var(--card); color: var(--card-foreground);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.06);
}
.pcp-notification-head {
  display: flex; align-items: center; gap: 0.375rem;
  font-size: 0.6875rem; line-height: 1rem; color: var(--muted-foreground);
}
.pcp-notification-app { font-weight: 500; }
.pcp-notification-time { margin-left: auto; }
.pcp-notification-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.125rem; height: 1.125rem; border-radius: 0.3125rem;
  background: color-mix(in oklab, var(--primary) 12%, transparent); color: var(--foreground);
}
.pcp-notification-icon svg { width: 0.75rem; height: 0.75rem; }
.pcp-notification-title { font-size: 0.875rem; line-height: 1.25rem; font-weight: 600; }
.pcp-notification-body { font-size: 0.8125rem; line-height: 1.25rem; color: var(--muted-foreground); }

/* The host's ToggleSwitch: a capsule with an oblong thumb, green when on. */









/*
 * One trigger's editor: its label, its two fields, and the preview of what will
 * actually be sent. A hairline between triggers keeps a long list readable
 * without boxing every entry.
 */



/*
 * A message field. The editable region and the insert button share one bordered
 * shell so the field reads as a single control, and :empty is what shows the
 * built-in wording — no placeholder node is ever inserted, which is what keeps
 * an empty field genuinely empty.
 */
.pcp-editor {
  position: relative; display: flex; align-items: flex-start; gap: 0.25rem;
  padding: 0.375rem 0.375rem 0.375rem 0.625rem;
  border: 1px solid var(--border); border-radius: var(--radius-md);
  background: transparent;
  transition: border-color 120ms, box-shadow 120ms;
}
.pcp-editor:focus-within {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}
.pcp-editor-field {
  flex: 1 1 auto; min-width: 0; min-height: 1.25rem;
  padding: 0;
  font-size: 0.875rem; line-height: 1.25rem; color: var(--foreground);
  white-space: pre-wrap; word-break: break-word;
  outline: none;
}
.pcp-editor-field:empty::before {
  content: attr(data-placeholder);
  color: var(--muted-foreground);
}

/* An object is atomic: not editable, removable, and movable in one click. */
.pcp-object {
  display: inline-flex; align-items: center;
  margin: 0 0.125rem;
  padding: 0 0.125rem 0 0.25rem;
  border-radius: 0.25rem;
  background: color-mix(in oklab, var(--primary) 12%, transparent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem; line-height: 1.125rem;
  color: var(--foreground);
  user-select: none;
  vertical-align: baseline;
}
.pcp-object-tools {
  display: inline-flex; align-items: center;
  margin-left: 0.0625rem;
  opacity: 0;
  transition: opacity 120ms;
}
.pcp-object:hover .pcp-object-tools,
.pcp-object:focus-within .pcp-object-tools { opacity: 1; }
.pcp-object-tool {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1rem; height: 1rem; padding: 0;
  border: 0; border-radius: 0.1875rem;
  background: transparent; color: var(--muted-foreground);
  font-family: inherit; font-size: 0.75rem; line-height: 1;
  cursor: pointer;
}
.pcp-object-tool:hover { background: var(--accent); color: var(--accent-foreground); }

.pcp-insert { position: relative; flex: 0 0 auto; }
.pcp-insert-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.5rem; height: 1.25rem; padding: 0;
  border: 0; border-radius: 0.25rem;
  background: transparent; color: var(--muted-foreground);
  cursor: pointer;
}
.pcp-insert-btn svg { width: 0.875rem; height: 0.875rem; }
.pcp-insert-btn:hover { background: var(--accent); color: var(--accent-foreground); }
.pcp-insert-menu {
  position: absolute; right: 0; top: calc(100% + 0.25rem); z-index: 20;
  display: grid; gap: 0.125rem; min-width: 16rem; padding: 0.25rem;
  background: var(--popover, var(--card));
  color: var(--popover-foreground, var(--card-foreground));
  border: 1px solid var(--border); border-radius: var(--radius-md);
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.18);
}
.pcp-insert-item {
  display: grid; gap: 0.125rem; padding: 0.375rem 0.5rem;
  border: 0; border-radius: 0.25rem;
  background: transparent; color: inherit;
  font-family: inherit; text-align: left; cursor: pointer;
}
.pcp-insert-item:hover { background: var(--accent); color: var(--accent-foreground); }
.pcp-insert-item strong {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem; font-weight: 500;
}
.pcp-insert-item span { font-size: 0.75rem; line-height: 1rem; color: var(--muted-foreground); }

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
