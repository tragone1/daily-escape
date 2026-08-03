/**
 * The config is about to be split across files. This pins its exact contents
 * first, so the split can prove it moved everything and changed nothing - a
 * tuning value silently dropped or altered in the move would be invisible
 * until someone noticed the game playing differently.
 */
import { describe, expect, it } from "vitest";
import { CONFIG } from "./config";

describe("the tuning", () => {
  it("is unchanged by reorganising it", () => {
    expect(JSON.stringify(CONFIG)).toMatchSnapshot();
  });
});
