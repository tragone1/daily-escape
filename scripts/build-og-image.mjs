/**
 * The picture that shows up when someone sends the link.
 *
 * A share with no image previews as a line of grey text, which is the weakest
 * possible version of "my friend sent me a game". This draws the card instead:
 * the road, the yellow car, two sets of blue lights behind it - the game's own
 * blocky look, in the game's own palette.
 *
 * No text in the image on purpose. Every platform renders og:title and
 * og:description as real text beside the picture, and those already carry the
 * score, the day and the challenge; text baked into the image would either
 * duplicate them or fight them, and it cannot be personalised per share anyway.
 *
 * Written by hand rather than with an image library: a PNG is a header, one
 * zlib stream of filtered scanlines, and a CRC per chunk - all of which Node
 * has already. It is not worth a dependency, and a build step that cannot break
 * is worth something.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const W = 1200;
const H = 630;

const px = new Uint8Array(W * H * 3);

/** sRGB-ish blend of a colour over what is already there. */
function put(x, y, [r, g, b], alpha = 1) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - alpha) + r * alpha;
  px[i + 1] = px[i + 1] * (1 - alpha) + g * alpha;
  px[i + 2] = px[i + 2] * (1 - alpha) + b * alpha;
}

function rect(x0, y0, w, h, colour, alpha = 1) {
  for (let y = Math.floor(y0); y < y0 + h; y++) {
    for (let x = Math.floor(x0); x < x0 + w; x++) put(x, y, colour, alpha);
  }
}

/** A horizontal span, for drawing shapes that change width down the image. */
function span(y, x0, x1, colour, alpha = 1) {
  for (let x = Math.floor(x0); x < x1; x++) put(x, y, colour, alpha);
}

// --- The sky: the game's own near-black, lifted a little toward the horizon --
const HORIZON = 250;
for (let y = 0; y < H; y++) {
  const t = Math.min(1, Math.max(0, (y - 40) / HORIZON));
  const c = [8 + 14 * t, 10 + 16 * t, 18 + 22 * t];
  span(y, 0, W, c);
}

// --- The road, in perspective: narrow at the horizon, full width at the foot -
const ROAD = [58, 58, 64];
const SHOULDER = [26, 34, 26];
const WALL = [120, 128, 148];
for (let y = HORIZON; y < H; y++) {
  const t = (y - HORIZON) / (H - HORIZON);
  const halfWidth = 40 + t * t * 760;
  const cx = W / 2;
  // Grass either side, then the wall line, then the road itself.
  span(y, 0, W, [14, 20, 16]);
  span(y, cx - halfWidth - 90 * t - 18, cx + halfWidth + 90 * t + 18, SHOULDER);
  span(y, cx - halfWidth - 18, cx - halfWidth, WALL, 0.55 + 0.45 * t);
  span(y, cx + halfWidth, cx + halfWidth + 18, WALL, 0.55 + 0.45 * t);
  span(y, cx - halfWidth, cx + halfWidth, ROAD);
}

/** Half the road's width at a given height, so things can be placed ON it. */
function roadHalf(y) {
  const t = Math.min(1, Math.max(0, (y - HORIZON) / (H - HORIZON)));
  return 40 + t * t * 760;
}

// --- Lane dashes. Spacing grows with the same square law as the road, so they
// --- read as distance rather than as a row of ticks.
let dashY = HORIZON + 4;
while (dashY < H) {
  const t = (dashY - HORIZON) / (H - HORIZON);
  // Chunky on purpose: this is usually seen as a thumbnail, where a
  // hairline centre line disappears entirely.
  const len = 10 + t * t * 62;
  const wide = 5 + t * t * 16;
  for (let y = dashY; y < Math.min(H, dashY + len); y++) {
    span(y, W / 2 - wide / 2, W / 2 + wide / 2, [236, 236, 226], 0.95);
  }
  dashY += len * 1.9;
}

/** One of the game's cars: a body, a darker cabin, and wheels either side. */
function car(cx, cy, scale, body, cabin, lights) {
  const w = 120 * scale;
  const h = 176 * scale;
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  // Contact shadow, so it sits on the road rather than floating over it.
  rect(x0 - 10 * scale, y0 + h - 14 * scale, w + 20 * scale, 26 * scale, [0, 0, 0], 0.34);
  rect(x0 - 12 * scale, y0 + 30 * scale, 12 * scale, h - 60 * scale, [16, 16, 20]);
  rect(x0 + w, y0 + 30 * scale, 12 * scale, h - 60 * scale, [16, 16, 20]);
  rect(x0, y0, w, h, body);
  rect(x0 + 14 * scale, y0 + 18 * scale, w - 28 * scale, 62 * scale, cabin);
  if (lights) {
    rect(x0 + 6 * scale, y0 - 12 * scale, w * 0.4, 16 * scale, [235, 60, 60]);
    rect(x0 + w * 0.55, y0 - 12 * scale, w * 0.4, 16 * scale, [70, 150, 255]);
  } else {
    // The player's tail lights.
    rect(x0 + 16 * scale, y0 + h - 34 * scale, w - 32 * scale, 18 * scale, [190, 40, 40]);
  }
}

/*
 * Two police cars up the road and the player nearest the viewer, each placed
 * as a fraction of the road's width at its own height - the road narrows fast,
 * and a fixed offset put them out on the grass.
 */
car(W / 2 - roadHalf(392) * 0.52, 392, 0.44, [232, 236, 244], [40, 46, 66], true);
car(W / 2 + roadHalf(332) * 0.55, 332, 0.32, [232, 236, 244], [40, 46, 66], true);
car(W / 2 - roadHalf(500) * 0.16, 500, 0.95, [246, 202, 46], [34, 40, 62], false);

// --- Vignette, so the eye lands on the car ---------------------------------
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - W / 2) / (W / 2);
    const dy = (y - H / 2) / (H / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0.72) put(x, y, [4, 5, 9], Math.min(0.82, (d - 0.72) * 1.5));
  }
}

// --- Encode ----------------------------------------------------------------
const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // truecolour
// Each scanline is prefixed with its filter type; 0 means "none".
const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "og.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`og image: ${out} (${(png.length / 1024).toFixed(0)} kB)`);
