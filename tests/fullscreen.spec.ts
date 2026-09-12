import { describe, expect, it } from "vitest";
import { nextFullscreenAction, resolveFullscreenState } from "../src/fullscreen.js";

describe("resolveFullscreenState", () => {
  it("is unsupported without the request API", () => {
    expect(resolveFullscreenState({}).supported).toBe(false);
    expect(resolveFullscreenState({ requestFullscreen: "not-a-function" }).supported).toBe(false);
  });

  it("treats a missing fullscreenEnabled as support, matching browsers that omit it", () => {
    expect(resolveFullscreenState({ requestFullscreen: () => {} }).supported).toBe(true);
  });

  it("is unsupported when the browser reports fullscreen as disabled", () => {
    // Some embedded contexts expose the API but refuse to use it.
    const state = resolveFullscreenState({ requestFullscreen: () => {}, fullscreenEnabled: false });
    expect(state.supported).toBe(false);
  });

  it("reports active only when an element is actually fullscreen", () => {
    const api = { requestFullscreen: () => {}, fullscreenEnabled: true };
    expect(resolveFullscreenState({ ...api, fullscreenElement: null }).active).toBe(false);
    expect(resolveFullscreenState({ ...api, fullscreenElement: { tagName: "HTML" } }).active).toBe(true);
  });

  it("never reports active without support", () => {
    // Guards the button against showing "Exit fullscreen" in a browser that
    // cannot have entered it.
    const state = resolveFullscreenState({ fullscreenElement: { tagName: "HTML" } });
    expect(state).toEqual({ supported: false, active: false });
  });
});

describe("nextFullscreenAction", () => {
  it("enters when the window is not fullscreen and exits when it is", () => {
    expect(nextFullscreenAction(false)).toBe("enter");
    expect(nextFullscreenAction(true)).toBe("exit");
  });
});
