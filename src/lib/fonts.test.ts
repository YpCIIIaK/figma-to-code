import { describe, it, expect } from "vitest";
import { guessMeta, refineWeights } from "./fonts";

describe("guessMeta", () => {
  it("gives a variable font the full weight range", () => {
    expect(guessMeta("TT Norms Pro Trial Variable.ttf")).toEqual({
      family: "TT Norms Pro Trial",
      weight: 100,
      weightMax: 900,
      style: "normal",
    });
  });

  it("reads numeric weights and drops subset suffixes", () => {
    expect(guessMeta("inter-500-cyrillic-ext.woff2")).toMatchObject({ family: "inter", weight: 500 });
    expect(guessMeta("euclid-flex-300.woff2")).toMatchObject({ family: "euclid flex", weight: 300 });
  });

  it("strips compound weight words from the family", () => {
    expect(guessMeta("TT Norms Pro Trial Condensed ExtraBlack.ttf")).toMatchObject({
      family: "TT Norms Pro Trial Condensed",
      weight: 900,
    });
  });
});

describe("refineWeights", () => {
  const face = (fileName: string) => ({ fileName, ...guessMeta(fileName), id: "" });

  it("treats Normal as 450 when the family also has Regular", () => {
    const out = refineWeights([face("TT Norms Pro Trial Regular.ttf"), face("TT Norms Pro Trial Normal.ttf")]);
    expect(out.map((f) => f.weight)).toEqual([400, 450]);
  });

  it("leaves a lone Normal at 400", () => {
    expect(refineWeights([face("Foo Normal.ttf")])[0].weight).toBe(400);
  });
});
