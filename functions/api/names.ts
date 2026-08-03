/**
 * What a leaderboard name is allowed to be.
 *
 * This runs on the server because it is the only side that matters: the client
 * check is a courtesy that saves a round trip, and anyone can skip it.
 *
 * The approach is an allowlist, not escaping. Names go into the DOM, and while
 * the client renders them with `textContent` and could not execute markup even
 * if it arrived, defence that depends on every future caller remembering to do
 * that is defence that eventually fails. There is no legitimate reason for a
 * leaderboard name to contain a tag.
 */

/**
 * Normalised to NFKC before anything else is decided.
 *
 * Without it "ＡＤＭＩＮ" in fullwidth characters is a different string from
 * "ADMIN" and walks straight past a word list, and visually identical names
 * can occupy separate rows. NFKC folds the compatibility forms that exist
 * precisely to look like other characters.
 */
export function normalizeName(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * Characters that carry no visible meaning and exist mainly to smuggle
 * something past a filter or to break a layout: zero-width spaces, direction
 * overrides, variation selectors, Hangul fillers and the C0/C1 control ranges.
 *
 * Written as escapes rather than literals on purpose. The literal form is a
 * run of characters nobody can see, which means nobody can review it and any
 * edit near it can silently destroy it.
 */
const INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/u;

/** Letters, numbers, spaces and a little punctuation. Nothing else. */
const ALLOWED = /^[\p{L}\p{N} _.'-]+$/u;

/**
 * Substitutions a determined player will reach for first.
 *
 * Deliberately shallow. A word list cannot win this and is not trying to: the
 * goal is that the obvious attempts do not land on a public board on day one,
 * not that the filter is unbeatable. Anything cleverer than this is caught by
 * a human with the moderation endpoint.
 */
const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i",
};

/**
 * Slurs, blocked wherever they appear.
 *
 * These are worth a false positive. Nothing innocent contains them, and a
 * public board carrying one for even an hour is a different order of problem
 * from a player having to pick another name.
 */
const BLOCKED_ANYWHERE = [
  "nigger", "nigga", "faggot", "kike", "chink", "rape", "paedo", "pedo",
];

/**
 * Ordinary profanity, blocked only as a whole word.
 *
 * Substring matching these is how a filter rejects Scunthorpe, Dickinson,
 * Cockburn and Cassiopeia - and a filter that rejects real names is worse than
 * one that lets a rude word through, because the player it fails has done
 * nothing wrong and has no idea why. Anything that gets past this is a job for
 * the moderation endpoint, which is a human looking at one row.
 */
const BLOCKED_WORDS = [
  "fuck", "shit", "cunt", "retard", "whore", "bitch", "dick", "cock",
  "pussy", "wank", "bastard", "slut", "twat", "arse",
];

/** Substitutions undone and separators dropped: "f.u_c k" and "f0ck" both become "fuck". */
function fold(name: string): string {
  let out = "";
  for (const ch of name.toLowerCase()) out += LEET[ch] ?? ch;
  return out.replace(/[^a-z]/g, "");
}

/**
 * The name split into runs of letters, with substitutions undone.
 *
 * Whole-word matching needs to know where the words are, which the fully
 * folded string has thrown away. Splitting on the separators a player would
 * actually type keeps "Scunthorpe" one word while still catching "f.u.c.k" -
 * whose pieces are single letters and so rejoin.
 */
function words(name: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const ch of name.toLowerCase()) {
    const mapped = LEET[ch] ?? ch;
    if (/[a-z]/.test(mapped)) current += mapped;
    else {
      // A single letter between separators is a spacing trick, not a word end.
      if (current.length === 1) continue;
      if (current) parts.push(current);
      current = "";
    }
  }
  if (current) parts.push(current);
  return parts;
}

export interface NameVerdict {
  ok: boolean;
  name?: string;
  /**
   * Shown to the player. Deliberately does not say WHICH rule was broken when
   * the reason is the word list - naming it is a hint about how to get round
   * it, and the player already knows what they typed.
   */
  reason?: string;
}

export function checkName(raw: unknown): NameVerdict {
  if (typeof raw !== "string") return { ok: false, reason: "Enter a name." };

  const name = normalizeName(raw);
  if (name.length === 0) return { ok: false, reason: "Enter a name." };
  if (name.length < 2) return { ok: false, reason: "Names need at least 2 characters." };
  if (name.length > 18) return { ok: false, reason: "Names can be at most 18 characters." };
  if (INVISIBLE.test(name)) return { ok: false, reason: "That name uses characters we can't show." };
  if (!ALLOWED.test(name)) {
    return { ok: false, reason: "Letters, numbers, spaces and . _ - ' only." };
  }

  /*
   * At least one actual letter, tested against the name itself rather than
   * against the folded ASCII - folding drops every non-Latin script, and a
   * player called 日本語 has a perfectly good name.
   */
  if (!/\p{L}/u.test(name)) {
    return { ok: false, reason: "Names need at least one letter." };
  }

  const folded = fold(name);
  for (const word of BLOCKED_ANYWHERE) {
    if (folded.includes(word)) return { ok: false, reason: "Please choose a different name." };
  }
  const parts = words(name);
  // The whole folded string counts as a word too, so "f u c k" is caught.
  parts.push(folded);
  for (const word of BLOCKED_WORDS) {
    if (parts.includes(word)) return { ok: false, reason: "Please choose a different name." };
  }

  return { ok: true, name };
}
