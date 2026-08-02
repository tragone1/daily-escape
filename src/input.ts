/** Keyboard input. Edge-triggered actions are consumed once so they cannot double-fire. */

export class Input {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();

  /** Fires once per keypress. */
  onRestart: (() => void) | null = null;
  onResetCamera: (() => void) | null = null;
  /** Any key at all — used to unlock the audio context on first interaction. */
  onAnyKey: (() => void) | null = null;
  /** First press of a driving key; starts the run. */
  onDrive: (() => void) | null = null;

  constructor() {
    window.addEventListener("keydown", this.handleDown);
    window.addEventListener("keyup", this.handleUp);
    window.addEventListener("blur", this.handleBlur);
  }

  private handleDown = (e: KeyboardEvent) => {
    const code = e.code;
    // Stop the page scrolling out from under the game.
    if (
      code === "Space" ||
      code === "ArrowUp" ||
      code === "ArrowDown" ||
      code === "ArrowLeft" ||
      code === "ArrowRight"
    ) {
      e.preventDefault();
    }
    this.onAnyKey?.();
    if (e.repeat) return;
    this.down.add(code);
    this.pressedThisFrame.add(code);

    if (
      code === "KeyW" || code === "KeyA" || code === "KeyS" || code === "KeyD" ||
      code === "ArrowUp" || code === "ArrowDown" || code === "ArrowLeft" ||
      code === "ArrowRight" || code === "Space"
    ) {
      this.onDrive?.();
    }
    if (code === "KeyP") this.onRestart?.();
    if (code === "KeyC") this.onResetCamera?.();
  };

  private handleUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  /** Losing focus mid-corner should not leave the throttle stuck on. */
  private handleBlur = () => {
    this.down.clear();
    this.pressedThisFrame.clear();
  };

  isDown(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  wasPressed(...codes: string[]): boolean {
    return codes.some((c) => this.pressedThisFrame.has(c));
  }

  /** Call at the end of every frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.handleDown);
    window.removeEventListener("keyup", this.handleUp);
    window.removeEventListener("blur", this.handleBlur);
  }
}
