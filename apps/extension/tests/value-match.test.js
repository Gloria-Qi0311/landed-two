require("../lib/value-match.js");

const VM = window.ResumeFillerValueMatch;

function opts(...texts) {
  // Prefix value so it never collides with target strings like "4" or "Master".
  return texts.map((t, i) => ({ text: t, value: `opt-${i}` }));
}

describe("pickBestOption — basic behavior", () => {
  test("returns null on empty target", () => {
    expect(VM.pickBestOption("", opts("a", "b"))).toBeNull();
    expect(VM.pickBestOption(null, opts("a", "b"))).toBeNull();
    expect(VM.pickBestOption(undefined, opts("a"))).toBeNull();
  });

  test("returns null on empty candidates", () => {
    expect(VM.pickBestOption("hello", [])).toBeNull();
    expect(VM.pickBestOption("hello", null)).toBeNull();
  });

  test("exact normalized match wins with confidence 1.0", () => {
    const r = VM.pickBestOption("Email", opts("Email", "Phone"));
    expect(r.candidate.text).toBe("Email");
    expect(r.confidence).toBe(1.0);
    expect(r.reason).toBe("exact");
  });

  test("exact match ignores case and surrounding whitespace", () => {
    const r = VM.pickBestOption("  bachelor  ", opts("BACHELOR", "Master"));
    expect(r.candidate.text).toBe("BACHELOR");
    expect(r.reason).toBe("exact");
  });

  test("exact match on option.value (when text differs)", () => {
    const candidates = [
      { text: "United States", value: "US" },
      { text: "United Kingdom", value: "GB" },
    ];
    const r = VM.pickBestOption("US", candidates);
    expect(r.candidate.value).toBe("US");
  });

  test("substring match falls back when no exact / alias / range hits", () => {
    const r = VM.pickBestOption("Engineer", opts("Software Engineer", "Manager"));
    expect(r.candidate.text).toBe("Software Engineer");
    expect(r.reason).toBe("substring");
    expect(r.confidence).toBeLessThan(0.7);
  });

  test("returns null when nothing matches at all", () => {
    expect(VM.pickBestOption("foo", opts("alpha", "beta", "gamma"))).toBeNull();
  });
});

describe("Degree abbreviations (cross-border core)", () => {
  test("Bachelor → BS", () => {
    const r = VM.pickBestOption("Bachelor", opts("BS", "MS", "PhD"));
    expect(r.candidate.text).toBe("BS");
    expect(r.reason).toBe("alias");
  });

  test("学士 → Bachelor's degree", () => {
    const r = VM.pickBestOption("学士", opts("High school diploma", "Bachelor's degree", "Master's degree", "PhD"));
    expect(r.candidate.text).toBe("Bachelor's degree");
    expect(r.reason).toBe("alias");
  });

  test("MS ↔ Master (in either direction)", () => {
    const r1 = VM.pickBestOption("MS", opts("Bachelor", "Master", "PhD"));
    expect(r1.candidate.text).toBe("Master");
    const r2 = VM.pickBestOption("硕士", opts("Bachelor", "Master", "PhD"));
    expect(r2.candidate.text).toBe("Master");
  });

  test("PhD ↔ Doctorate", () => {
    const r = VM.pickBestOption("PhD", opts("Bachelor's", "Master's", "Doctorate"));
    expect(r.candidate.text).toBe("Doctorate");
  });
});

describe("Language proficiency synonyms", () => {
  test("Native → 母语", () => {
    const r = VM.pickBestOption("Native", opts("入门", "日常", "商务", "流利", "母语"));
    expect(r.candidate.text).toBe("母语");
  });

  test("Full professional proficiency → Fluent", () => {
    const r = VM.pickBestOption("Full professional proficiency", opts("Beginner", "Conversational", "Fluent", "Native"));
    expect(r.candidate.text).toBe("Fluent");
  });

  test("流利 → Full professional proficiency", () => {
    const r = VM.pickBestOption("流利", opts("Beginner", "Conversational", "Full professional proficiency", "Native"));
    expect(r.candidate.text).toBe("Full professional proficiency");
  });
});

describe("Years-of-experience range matching", () => {
  test("3 years → 3-5 years range", () => {
    const r = VM.pickBestOption("3 years", opts("0-1 years", "2-3 years", "3-5 years", "6+ years"));
    expect(r.reason).toBe("range");
    // Both "2-3 years" and "3-5 years" overlap with target=3; either is acceptable.
    expect(["2-3 years", "3-5 years"]).toContain(r.candidate.text);
  });

  test("7 → 6+ years", () => {
    const r = VM.pickBestOption("7", opts("0-1", "2-3", "4-5", "6+ years"));
    expect(r.reason).toBe("range");
    expect(r.candidate.text).toBe("6+ years");
  });

  test("10+ → 10+ years exact range", () => {
    const r = VM.pickBestOption("10+ years experience", opts("1-3 years", "4-9 years", "10+ years"));
    expect(r.candidate.text).toBe("10+ years");
  });

  test("less than 1 year → 0-1 years bucket", () => {
    const r = VM.pickBestOption("less than 1 year", opts("0-1 years", "2-5 years", "6+ years"));
    expect(r.candidate.text).toBe("0-1 years");
  });

  test("CJK range 3 至 5 years", () => {
    const r = VM.pickBestOption("4 年", opts("0 至 1 年", "2 至 3 年", "3 至 5 年", "6 年以上"));
    expect(r.reason).toBe("range");
    expect(r.candidate.text).toBe("3 至 5 年");
  });
});

describe("parseYearsValue", () => {
  test("parses ranges with various separators", () => {
    expect(VM.parseYearsValue("3-5 years")).toEqual({ min: 3, max: 5 });
    expect(VM.parseYearsValue("3–5")).toEqual({ min: 3, max: 5 });
    expect(VM.parseYearsValue("3~5")).toEqual({ min: 3, max: 5 });
    expect(VM.parseYearsValue("3 至 5")).toEqual({ min: 3, max: 5 });
  });

  test("parses N+ as min N", () => {
    expect(VM.parseYearsValue("5+")).toEqual({ min: 5, max: 999 });
    expect(VM.parseYearsValue("10+ years")).toEqual({ min: 10, max: 999 });
  });

  test("parses 'less than N'", () => {
    expect(VM.parseYearsValue("less than 2 years")).toEqual({ min: 0, max: 1 });
    expect(VM.parseYearsValue("under 1")).toEqual({ min: 0, max: 0 });
  });

  test("parses lone integers", () => {
    expect(VM.parseYearsValue("3")).toEqual({ min: 3, max: 3 });
    expect(VM.parseYearsValue("3 years")).toEqual({ min: 3, max: 3 });
    expect(VM.parseYearsValue("5 年")).toEqual({ min: 5, max: 5 });
  });

  test("returns null for non-year strings", () => {
    expect(VM.parseYearsValue("Bachelor")).toBeNull();
    expect(VM.parseYearsValue("")).toBeNull();
    expect(VM.parseYearsValue(null)).toBeNull();
  });
});

describe("Confidence ordering", () => {
  test("exact > alias > range > substring", () => {
    const exact = VM.pickBestOption("Bachelor", opts("Bachelor"));
    const alias = VM.pickBestOption("Bachelor", opts("BS"));
    const substring = VM.pickBestOption("Engineer", opts("Software Engineer"));
    expect(exact.confidence).toBeGreaterThan(alias.confidence);
    expect(alias.confidence).toBeGreaterThan(substring.confidence);
  });
});

// ── Realistic ATS option lists (issue #4 acceptance: ≥5 cases) ──────────
//
// Captured from typical Workday / Greenhouse / Lever / iCIMS / Ashby
// dropdowns in 2024-2026. Resume value → expected matched option.

describe("Real ATS dropdown fixtures", () => {
  test("Workday: highest level of education achieved", () => {
    const candidates = opts(
      "Select One",
      "Less than High School",
      "High School Diploma / GED",
      "Associate's Degree",
      "Bachelor's Degree",
      "Master's Degree",
      "Doctorate",
      "Professional Degree (MD, JD)",
    );
    expect(VM.pickBestOption("硕士", candidates).candidate.text).toBe("Master's Degree");
    expect(VM.pickBestOption("PhD", candidates).candidate.text).toBe("Doctorate");
    expect(VM.pickBestOption("BS", candidates).candidate.text).toBe("Bachelor's Degree");
  });

  test("Greenhouse: years of relevant experience", () => {
    const candidates = opts(
      "Please select",
      "Less than 1 year",
      "1-2 years",
      "3-5 years",
      "6-10 years",
      "More than 10 years",
    );
    expect(VM.pickBestOption("4", candidates).candidate.text).toBe("3-5 years");
    expect(VM.pickBestOption("12 years", candidates).candidate.text).toBe("More than 10 years");
    expect(VM.pickBestOption("0", candidates).candidate.text).toBe("Less than 1 year");
  });

  test("Lever: language proficiency (LinkedIn-style scale)", () => {
    const candidates = opts(
      "Elementary proficiency",
      "Limited working proficiency",
      "Professional working proficiency",
      "Full professional proficiency",
      "Native or bilingual proficiency",
    );
    expect(VM.pickBestOption("Native", candidates).candidate.text).toBe("Native or bilingual proficiency");
    expect(VM.pickBestOption("流利", candidates).candidate.text).toBe("Full professional proficiency");
    expect(VM.pickBestOption("商务", candidates).candidate.text).toBe("Professional working proficiency");
  });

  test("iCIMS: yes/no work authorization", () => {
    const candidates = opts("--Select One--", "Yes", "No");
    expect(VM.pickBestOption("是", candidates).candidate.text).toBe("Yes");
    expect(VM.pickBestOption("否", candidates).candidate.text).toBe("No");
  });

  test("Ashby: Chinese-localised degree dropdown", () => {
    const candidates = opts(
      "请选择",
      "高中",
      "大专",
      "本科",
      "硕士",
      "博士",
    );
    expect(VM.pickBestOption("Bachelor", candidates).candidate.text).toBe("本科");
    expect(VM.pickBestOption("PhD", candidates).candidate.text).toBe("博士");
    expect(VM.pickBestOption("MBA", candidates).candidate.text).toBe("硕士");
  });

  test("Workday-style: country code combobox", () => {
    const candidates = [
      { text: "United States of America", value: "USA" },
      { text: "United Kingdom", value: "GBR" },
      { text: "China", value: "CHN" },
      { text: "Canada", value: "CAN" },
    ];
    expect(VM.pickBestOption("USA", candidates).candidate.value).toBe("USA");
    expect(VM.pickBestOption("United States", candidates).candidate.text).toBe("United States of America");
  });
});
