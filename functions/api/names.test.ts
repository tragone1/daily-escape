/**
 * Name validation is the one place hostile input reaches a public surface, so
 * it is tested as hostile input rather than as a happy path.
 *
 * Invisible characters are written as escapes here for the same reason they
 * are in the implementation: a test whose intent is invisible cannot be
 * reviewed, and can be destroyed by an unrelated edit without anyone noticing.
 */
import { describe, expect, it } from "vitest";
import { checkName, normalizeName } from "./names";

const ok = (n: string): boolean => checkName(n).ok;

describe("names that must work", () => {
  it("accepts ordinary ones, including non-Latin and accented", () => {
    for (const n of ["Tyler", "Ana-Maria", "O'Brien", "player_1", "Renée", "日本語", "Ali 99"]) {
      expect(ok(n), n).toBe(true);
    }
  });

  it("does not reject innocent names containing awkward substrings", () => {
    // The classic false positives. A filter that fails these is worse than none.
    for (const n of ["Cassiopeia", "Scunthorpe", "Dickinson", "Cockburn", "Analiese"]) {
      expect(ok(n), n).toBe(true);
    }
  });

  it("trims and collapses whitespace rather than rejecting it", () => {
    expect(checkName("  Tyler   Ragone ").name).toBe("Tyler Ragone");
  });
});

describe("names that must not", () => {
  it("rejects blank and whitespace-only", () => {
    for (const n of ["", " ", "\t\n", "   "]) expect(ok(n), JSON.stringify(n)).toBe(false);
  });

  it("rejects lengths outside 2-18", () => {
    expect(ok("a")).toBe(false);
    expect(ok("x".repeat(19))).toBe(false);
    expect(ok("x".repeat(18))).toBe(true);
  });

  it("rejects markup and script injection", () => {
    for (const n of [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "a<b>c",
      "javascript:alert(1)",
    ]) {
      expect(ok(n), n).toBe(false);
    }
  });

  it("rejects SQL-injection shapes that contain disallowed characters", () => {
    for (const n of ["'; DROP TABLE scores;--", '" OR 1=1 --', "1=1; --"]) {
      expect(ok(n), n).toBe(false);
    }
  });

  it("accepts injection-shaped strings that are only punctuation, harmlessly", () => {
    /*
     * "admin'--" is made of allowed characters and is accepted as a NAME. That
     * is correct: queries are parameterised so it cannot reach SQL as code,
     * and it is rendered with textContent so it cannot reach the DOM as
     * markup. Rejecting it would be theatre - the defence is the query, not
     * the spelling.
     */
    expect(ok("admin'--")).toBe(true);
  });

  it("rejects invisible and direction-override characters", () => {
    const hostile = [
      "Tyler​X", // zero-width space
      "ab‮cd", // right-to-left override
      "a­b", // soft hyphen
      "nㅤame", // Hangul filler, renders as a space
    ];
    for (const n of hostile) expect(ok(n), JSON.stringify(n)).toBe(false);
  });

  it("folds a byte-order mark to a space rather than rejecting the name", () => {
    // JavaScript's \s matches U+FEFF, so it collapses with the other
    // whitespace. The result is visible and harmless, which is a better
    // outcome than a rejection the player cannot see the cause of.
    expect(checkName("x\uFEFFy").name).toBe("x y");
  });

  it("rejects names with no letters at all", () => {
    for (const n of ["123456", "...--..", "42"]) expect(ok(n), n).toBe(false);
  });
});

describe("normalization", () => {
  it("folds fullwidth forms, so they cannot walk past the word list", () => {
    // Without NFKC this is a different string from "TYLER" entirely.
    expect(normalizeName("ＴＹＬＥＲ")).toBe("TYLER");
    // And the same trick applied to something that must be blocked.
    expect(ok("ｆｕｃｋ")).toBe(false);
  });

  it("catches spacing and substitution attempts", () => {
    for (const n of ["f u c k", "f.u.c.k", "fu_ck", "F-U-C-K", "sh1t", "$hit", "n1gger", "SHIT"]) {
      expect(ok(n), n).toBe(false);
    }
  });

  it("is honest about what it does not catch", () => {
    /*
     * The filter undoes a fixed set of substitutions; a spelling outside that
     * set gets through, and is meant to. Pursuing every variant costs false
     * positives against real names, which is the worse failure - so the design
     * is a shallow filter plus a moderation endpoint, not a clever filter
     * alone. This test exists so that trade-off is stated rather than
     * discovered.
     */
    expect(ok("phuck")).toBe(true);
  });

  it("does not say which rule a blocked word broke", () => {
    // Naming the rule is a hint about how to get round it.
    const reason = (checkName("fuck").reason ?? "").toLowerCase();
    expect(reason).not.toContain("word");
    expect(reason).not.toContain("profan");
    expect(reason).not.toContain("blocked");
  });
});
