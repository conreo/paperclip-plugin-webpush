import { useCallback, useEffect, useRef, useState } from "react";
import {
  TEMPLATE_OBJECT_HINTS,
  isTemplateObject,
  normalizeTemplate,
  parseTemplate,
  serializeTemplate,
  type TemplateObject,
  type TemplateSegment,
} from "../notifications.js";

/**
 * A message field whose substitutions are objects, not text.
 *
 * The previous version of this page was a plain text input whose value was a
 * template string, so an operator had to type `{{agent}}` themselves: a typo
 * produced a notification that read `{{agent}}` to whoever received it, and
 * there was nothing to drag, so the order of the parts was fixed by retyping.
 *
 * Here an object is an atomic chip. It is inserted from a list (never typed), it
 * can be moved or removed, and the only thing that ever reaches storage is a
 * serialisation of what is on screen. Braces typed by hand are ordinary text and
 * are converted to chips on blur if they name an object, so the field cannot end
 * up in a state its preview does not show.
 *
 * The field is a `contentEditable` element that React deliberately does not own:
 * it renders no children, and the DOM is rewritten only when the incoming value
 * no longer matches what is on screen — otherwise every keystroke would reset
 * the caret to the start.
 */

type Props = {
  /** The stored template, which is what the field renders. */
  value: string;
  /** Objects this trigger has a value for; the insert list offers exactly these. */
  objects: TemplateObject[];
  /** Built-in wording, shown while the field is empty (and what an empty field sends). */
  builtIn: string;
  onChange: (next: string) => void;
  testId: string;
  ariaLabel: string;
};

function isChip(node: Node | null): node is HTMLElement {
  return node instanceof HTMLElement && node.dataset.object !== undefined;
}

function chipElement(name: TemplateObject): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "pcp-object";
  chip.dataset.object = name;
  // Atomic: without this the browser treats the chip's interior as editable, so
  // typing next to an object types *inside* it and the next inserted object nests
  // within the previous one — a message that serialises as something the operator
  // never wrote.
  chip.contentEditable = "false";
  chip.spellcheck = false;
  // Deliberately no role="button": the chip *contains* buttons, and a button inside
  // a button is invalid. It also picked up the host's coarse-pointer rule, which
  // floors anything with role="button" at 44px — on a tablet a chip drew as a tall
  // block instead of a word in a sentence. The chip's own controls carry the labels.


  const label = document.createElement("span");
  label.className = "pcp-object-label";
  label.textContent = `{{${name}}}`;
  chip.appendChild(label);

  const tools = document.createElement("span");
  tools.className = "pcp-object-tools";
  for (const [action, glyph, title] of [
    ["left", "‹", "Move before the previous object"],
    ["right", "›", "Move after the next object"],
    ["remove", "×", `Remove {{${name}}}`],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pcp-object-tool";
    // Same reason as the switch: the host's coarse-pointer rule floors every
    // button at 44px, which would turn a chunk of a message into a stack of
    // tall buttons on a tablet. The chip's row provides the touch area.
    button.dataset.slot = "icon-button";
    button.dataset.action = action;
    button.setAttribute("aria-label", title);
    button.title = title;
    button.textContent = glyph;
    // Keep the caret where it is: without this the click would collapse the
    // selection before the handler runs.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    tools.appendChild(button);
  }
  chip.appendChild(tools);
  return chip;
}

/**
 * Read the field back as segments. The DOM is the source of truth while typing.
 *
 * The walk is recursive rather than a flat sweep of the direct children: a node
 * that somehow contains objects (a wrapping node left by a paste, or DOM written
 * by an earlier version of this editor) contributes its contents in order instead
 * of being flattened into text, so no object can be silently lost on save.
 */
function segmentsFromDom(root: HTMLElement): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      if (value) segments.push({ kind: "text", value });
      continue;
    }
    if (isChip(node)) {
      segments.push({ kind: "object", name: node.dataset.object as TemplateObject });
      continue;
    }
    if (node instanceof HTMLElement && node.querySelector(".pcp-object")) {
      segments.push(...segmentsFromDom(node));
      continue;
    }
    // Anything else (`<br>`, a `<span>` left by a paste) contributes its text.
    const value = node.textContent ?? "";
    if (value) segments.push({ kind: "text", value });
  }
  return segments;
}

function renderSegments(root: HTMLElement, segments: readonly TemplateSegment[]): void {
  root.replaceChildren(
    ...segments.map((segment) =>
      segment.kind === "object" ? chipElement(segment.name) : document.createTextNode(segment.value),
    ),
  );
}

export function TemplateEditor({ value, objects, builtIn, onChange, testId, ariaLabel }: Props) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const commit = useCallback(() => {
    const field = fieldRef.current;
    if (!field) return;
    onChange(serializeTemplate(segmentsFromDom(field)));
  }, [onChange]);

  // Rewrite the DOM only when it does not already represent `value`.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    if (serializeTemplate(segmentsFromDom(field)) === value) return;
    renderSegments(field, value ? parseTemplate(value) : []);
  }, [value]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  /** Remember where the caret was, so the insert list can put an object there. */
  const rememberRange = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const field = fieldRef.current;
    if (field && field.contains(range.startContainer)) savedRange.current = range.cloneRange();
  }, []);

  const handleTools = useCallback(
    (chip: HTMLElement, action: string) => {
      const parent = chip.parentNode;
      if (!parent) return;

      if (action === "remove") {
        chip.remove();
      } else {
        // Swap with the neighbouring *object*, not the neighbouring node, and
        // exchange their positions rather than moving one past the other: in
        // "{{title}} for {{org}}" an operator means the two objects change
        // places, so the words between them stay put. Moving one node instead
        // would produce "{{org}}{{title}} for".
        const siblings = Array.from(parent.childNodes).filter(isChip);
        const index = siblings.indexOf(chip);
        const target = action === "left" ? siblings[index - 1] : siblings[index + 1];
        if (!target) return;

        // A marker holds the vacated slot while the two objects trade places.
        const marker = document.createComment("swap");
        parent.insertBefore(marker, chip);
        if (action === "left") parent.insertBefore(chip, target);
        else parent.insertBefore(chip, target.nextSibling);
        parent.replaceChild(target, marker);
      }
      commit();
    },
    [commit],
  );

  const onFieldClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(".pcp-object");
      const action = target.dataset.action;
      if (chip instanceof HTMLElement && action) {
        event.preventDefault();
        handleTools(chip, action);
        return;
      }
      rememberRange();
    },
    [handleTools, rememberRange],
  );

  const insert = useCallback(
    (name: TemplateObject) => {
      const field = fieldRef.current;
      if (!field) return;
      const chip = chipElement(name);
      const range = savedRange.current;

      if (range && field.contains(range.startContainer)) {
        range.deleteContents();
        range.insertNode(chip);
        const after = document.createRange();
        after.setStartAfter(chip);
        after.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(after);
        savedRange.current = after.cloneRange();
      } else {
        // No caret in this field yet: an empty field means "the whole message",
        // so the object goes at the end of what is already there.
        field.appendChild(chip);
      }

      setMenuOpen(false);
      field.focus();
      commit();
    },
    [commit],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // A push title and body are single-line: a newline would be stripped by
      // the notification anyway, so never create one.
      if (event.key === "Enter") {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== "Backspace" && event.key !== "Delete") return;

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const field = fieldRef.current;
      if (!field) return;

      // Delete a chip as one unit, the way a character is deleted.
      let doomed: Node | null = null;
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const text = range.startContainer;
        const atEdge =
          event.key === "Backspace"
            ? range.startOffset === 0
            : range.startOffset === (text.textContent ?? "").length;
        if (atEdge) {
          doomed = event.key === "Backspace" ? text.previousSibling : text.nextSibling;
        }
      } else if (range.startContainer === field) {
        doomed = field.childNodes[event.key === "Backspace" ? range.startOffset - 1 : range.startOffset] ?? null;
      }

      if (isChip(doomed)) {
        event.preventDefault();
        doomed.remove();
        commit();
      }
    },
    [commit],
  );

  const onBlur = useCallback(() => {
    const field = fieldRef.current;
    if (!field) return;
    // Hand-typed braces become real objects here, off the typing path so the
    // caret never moves mid-keystroke. A name that is not an object stays text
    // and simply renders as written.
    const current = serializeTemplate(segmentsFromDom(field));
    const normalized = normalizeTemplate(current);
    if (normalized !== current) {
      renderSegments(field, parseTemplate(normalized));
      commit();
    }
  }, [commit]);

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain").replace(/\s*\r?\n\s*/g, " ");
      document.execCommand("insertText", false, text);
    },
    [],
  );

  return (
    <div className="pcp-editor" onMouseDown={(event) => event.stopPropagation()}>
      <div
        ref={fieldRef}
        className="pcp-editor-field"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="false"
        data-testid={testId}
        data-placeholder={builtIn}
        onInput={commit}
        onClick={onFieldClick}
        onKeyDown={onKeyDown}
        onKeyUp={rememberRange}
        onMouseUp={rememberRange}
        onBlur={onBlur}
        onPaste={onPaste}
      />

      <div className="pcp-insert">
        <button
          type="button"
          className="pcp-insert-btn"
          data-slot="icon-button"
          aria-label="Insert an object"
          aria-expanded={menuOpen}
          title="Insert an object"
          data-testid={`${testId}-insert`}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>

        {menuOpen ? (
          <div className="pcp-insert-menu" role="menu" data-testid={`${testId}-objects`}>
            {objects.map((name) => (
              <button
                key={name}
                type="button"
                role="menuitem"
                className="pcp-insert-item"
                data-testid={`${testId}-object-${name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(name)}
              >
                <strong>{`{{${name}}}`}</strong>
                <span>{TEMPLATE_OBJECT_HINTS[name]}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
