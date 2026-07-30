import { CONFIG } from "./config";
import { webgl2Problem } from "./compat";
import { Game } from "./game";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
if (!canvas) throw new Error("#renderCanvas not found");

/*
 * Nothing below may fail silently.
 *
 * A throw here leaves a black canvas and no explanation, which is what it did for a Safari
 * user while working everywhere else. WebGL2 is checked first because it is the one
 * requirement a browser can simply not meet, and it deserves an answer rather than a stack
 * trace; anything else is reported through the same surface.
 */
declare const __bootError: ((message: string) => void) | undefined;
const report = (message: string): void => {
  if (typeof __bootError === "function") __bootError(message);
  else console.error(message);
};

const problem = webgl2Problem(canvas);
if (problem) {
  report(problem);
} else {
  try {
    const game = new Game(canvas);
    game.start();
    (window as unknown as { __game: Game }).__game = game;
    (window as unknown as { __cfg: typeof CONFIG }).__cfg = CONFIG;
  } catch (err) {
    report(err instanceof Error ? `${err.message}` : String(err));
  }
}

