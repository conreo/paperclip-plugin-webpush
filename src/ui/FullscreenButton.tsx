import { useCallback, useEffect, useState } from "react";
import {
  nextFullscreenAction,
  resolveFullscreenState,
  type FullscreenState,
} from "../fullscreen.js";
import { usePluginStyles } from "./styles.js";

const UNSUPPORTED: FullscreenState = { supported: false, active: false };

function readState(): FullscreenState {
  if (typeof document === "undefined") return UNSUPPORTED;
  return resolveFullscreenState({
    requestFullscreen: document.documentElement?.requestFullscreen,
    exitFullscreen: document.exitFullscreen,
    fullscreenElement: document.fullscreenElement,
    fullscreenEnabled: document.fullscreenEnabled,
  });
}

function Icon({ entering }: { entering: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {entering ? (
        <>
          <path d="M6 2H2v4" />
          <path d="M10 14h4v-4" />
          <path d="M2 2l4.5 4.5" />
          <path d="M14 14l-4.5-4.5" />
        </>
      ) : (
        <>
          <path d="M6 2v4H2" />
          <path d="M10 14v-4h4" />
          <path d="M6 6L2 2" />
          <path d="M10 10l4 4" />
        </>
      )}
    </svg>
  );
}

/**
 * Toolbar button that toggles immersive fullscreen.
 *
 * Renders nothing where the API is unavailable, so the toolbar stays clean
 * instead of offering a button that cannot work. This is Chromium's Fullscreen
 * API — an on-demand window, not an installed app's display mode — so the
 * address bar and the Android system bars return when the user swipes or the
 * page reloads.
 */
export function FullscreenButton() {
  usePluginStyles();
  const [state, setState] = useState<FullscreenState>(readState);

  useEffect(() => {
    const update = () => setState(readState());
    update();
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const toggle = useCallback(async () => {
    try {
      if (nextFullscreenAction(state.active) === "exit") {
        await document.exitFullscreen();
      } else {
        // The API requires a user gesture, and a click is one.
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // A refusal (no gesture, an embedded context, or a browser policy) leaves
      // the window as it was. There is nothing useful to tell the user here.
    } finally {
      setState(readState());
    }
  }, [state.active]);

  if (!state.supported) return null;

  const label = state.active ? "Exit fullscreen" : "Enter fullscreen";

  return (
    <button
      type="button"
      data-testid="fullscreen-toggle"
      aria-label={label}
      title={label}
      aria-pressed={state.active}
      onClick={() => void toggle()}
      className="pcp-icon-btn"
    >
      <Icon entering={!state.active} />
    </button>
  );
}
