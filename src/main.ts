import { Game } from "./game";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
if (!canvas) throw new Error("#renderCanvas not found");

const game = new Game(canvas);
game.start();

// Handy while tuning: `window.__game` in the console.
(window as unknown as { __game: Game }).__game = game;
