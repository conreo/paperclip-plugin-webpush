/**
 * Fullscreen state, kept pure so it can be tested without a browser.
 *
 * This drives an on-demand immersive window (the Fullscreen API), which is a
 * different mechanism from an installed app's `display` mode: `display-mode:
 * fullscreen` stays false here, and the window leaves fullscreen on reload.
 */
export type FullscreenState = { supported: boolean; active: boolean };

/** Minimal shape of the APIs this reads, so tests can pass fakes. */
export type FullscreenEnvironment = {
  requestFullscreen?: unknown;
  exitFullscreen?: unknown;
  fullscreenElement?: unknown;
  fullscreenEnabled?: boolean;
};

export function resolveFullscreenState(environment: FullscreenEnvironment): FullscreenState {
  const supported =
    typeof environment.requestFullscreen === "function" &&
    (environment.fullscreenEnabled === undefined || environment.fullscreenEnabled === true);

  return { supported, active: supported && Boolean(environment.fullscreenElement) };
}

export function nextFullscreenAction(active: boolean): "enter" | "exit" {
  return active ? "exit" : "enter";
}
