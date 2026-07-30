/**
 * Browser capability checks and small fallbacks.
 *
 * Everything here exists because a hard failure in this game presents as a black screen,
 * and a black screen tells the person looking at it nothing at all. The aim is that any
 * unsupported browser says *what* it cannot do, and that anything survivable is survived.
 */

/** What WebGL2 support looks like, and what to tell someone who has not got it. */
export function webgl2Problem(canvas: HTMLCanvasElement): string | null {
  if (typeof WebGL2RenderingContext === "undefined") {
    return (
      "This browser does not support WebGL2, which the game needs to draw anything.\n\n" +
      "Safari supports it from version 15 (macOS Monterey) onward. On older Safari it can " +
      "sometimes be turned on under Develop › Experimental Features › WebGL 2.0."
    );
  }
  // Present as a type but still refused: usually hardware acceleration being off, a
  // blocklisted driver, or too many live contexts on the page.
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
  } catch {
    gl = null;
  }
  if (!gl) {
    return (
      "This browser knows about WebGL2 but refused to create a context.\n\n" +
      "That is usually hardware acceleration being switched off, or a graphics driver the " +
      "browser will not use. In Safari, check that Develop › Experimental Features has " +
      "nothing WebGL-related disabled."
    );
  }
  // Hand the context back rather than leaking it; the renderer will ask for its own and
  // getContext returns the same one for the same canvas and type.
  return null;
}

/**
 * Build a regex that may use unicode property escapes, falling back if unsupported.
 *
 * `/\p{L}/u` written as a literal is a **parse-time** SyntaxError on an engine that does
 * not know property escapes, which takes the whole bundle down rather than the one feature
 * that needed it. Constructing it at runtime turns that into a catchable problem.
 */
export function letterNumberPattern(): RegExp {
  try {
    return new RegExp("^[\\p{L}\\p{N} _.'-]+$", "u");
  } catch {
    // Latin plus common accents. Narrower than intended, and better than not booting.
    return /^[A-Za-z0-9À-ɏ _.'-]+$/;
  }
}

/**
 * Replace a node's children. `replaceChildren` is Safari 14 and later; older Safari would
 * throw here, and this is called every time the leaderboard is opened.
 */
export function setChildren(node: Element, children: Node[]): void {
  if (typeof node.replaceChildren === "function") {
    node.replaceChildren(...children);
    return;
  }
  while (node.firstChild) node.removeChild(node.firstChild);
  for (const child of children) node.appendChild(child);
}
