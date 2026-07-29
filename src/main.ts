import { CONFIG } from "./config";
import { Game } from "./game";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
if (!canvas) throw new Error("#renderCanvas not found");

const game = new Game(canvas);
game.start();

// Handy while tuning: `window.__game` in the console.
(window as unknown as { __game: Game }).__game = game;
// Also handy while tuning: `window.__cfg` is the live CONFIG object, so a value can be
// A/B tested against an identical scenario without a rebuild.
(window as unknown as { __cfg: typeof CONFIG }).__cfg = CONFIG;
