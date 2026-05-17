require("../schema.js");

const {
  RESUME_SCHEMA,
  emptyResume,
  normalizeResume,
  isResumeFilled,
  flattenResumeForFill
} = window;

describe("RESUME_SCHEMA", () => {
  test("declares the documented top-level structure", () => {
    expect(RESUME_SCHEMA.version).toBe(2);
    expect(RESUME_SCHEMA).toHaveProperty("basic.email");
    expect(RESUME_SCHEMA).toHaveProperty("basic.englishName");
    expect(RESUME_SCHEMA).toHaveProperty("basic.chineseName");
    expect(RESUME_SCHEMA).toHaveProperty("intent.apply_position");
    expect(Array.isArray(RESUME_SCHEMA.education)).toBe(true);
    expect(Array.isArray(RESUME_SCHEMA.experience)).toBe(true);
    expect(Array.isArray(RESUME_SCHEMA.internship)).toBe(true);
    expect(Array.isArray(RESUME_SCHEMA.projects)).toBe(true);
    expect(Array.isArray(RESUME_SCHEMA.skills)).toBe(true);
    expect(Array.isArray(RESUME_SCHEMA.languages)).toBe(true);
  });
});

describe("normalizeResume", () => {
  test("returns an empty resume for undefined input", () => {
    expect(normalizeResume(undefined)).toEqual(emptyResume());
  });

  test("returns an empty resume for non-object input", () => {
    expect(normalizeResume("not a resume")).toEqual(emptyResume());
    expect(normalizeResume(42)).toEqual(emptyResume());
  });

  test("preserves provided fields and backfills missing ones", () => {
    const out = normalizeResume({ basic: { email: "x@y.com" } });
    expect(out.basic.email).toBe("x@y.com");
    expect(out.basic.name).toBe("");
    expect(out.intent.apply_position).toBe("");
    expect(out.education).toEqual([]);
  });

  test("coerces numeric and boolean values appropriately", () => {
    const out = normalizeResume({
      basic: { phone: 12345 },
      experience: [{ company: "Acme", current: true }]
    });
    expect(out.basic.phone).toBe("12345");
    expect(out.experience[0].current).toBe(true);
    expect(out.experience[0].company).toBe("Acme");
  });

  test("upgrades legacy flat schema into the structured form", () => {
    const out = normalizeResume({
      name: "Alice",
      email: "alice@example.com",
      edu_school: "MIT",
      current_company: "Acme"
    });
    expect(out.basic.name).toBe("Alice");
    expect(out.basic.email).toBe("alice@example.com");
    expect(out.education[0].school).toBe("MIT");
    expect(out.experience[0].company).toBe("Acme");
    expect(out.experience[0].current).toBe(true);
  });
});

describe("isResumeFilled", () => {
  test("is false for an empty resume", () => {
    expect(isResumeFilled(emptyResume())).toBeFalsy();
  });

  test("is false for non-object input", () => {
    expect(isResumeFilled(null)).toBe(false);
    expect(isResumeFilled(undefined)).toBe(false);
  });

  test("is true when basic has any non-blank value", () => {
    const r = emptyResume();
    r.basic.name = "Alice";
    expect(isResumeFilled(r)).toBe(true);
  });

  test("is true when at least one section has entries", () => {
    const r = normalizeResume({ education: [{ school: "MIT" }] });
    expect(isResumeFilled(r)).toBe(true);
  });
});

describe("flattenResumeForFill", () => {
  test("flattens basic + intent + first entry of each multi-section", () => {
    const flat = flattenResumeForFill({
      basic: { email: "x@y.com", name: "Alice" },
      intent: { apply_position: "PM" },
      education: [{ school: "MIT", major: "CS" }],
      experience: [{ company: "Acme", title: "Engineer" }],
      projects: [{ name: "Foo" }],
      skills: ["js", "react"],
      languages: ["English", "Mandarin"]
    });
    expect(flat.email).toBe("x@y.com");
    expect(flat.name).toBe("Alice");
    expect(flat.apply_position).toBe("PM");
    expect(flat.edu_school).toBe("MIT");
    expect(flat.edu_major).toBe("CS");
    expect(flat.current_company).toBe("Acme");
    expect(flat.current_title).toBe("Engineer");
    expect(flat.project_name).toBe("Foo");
    expect(flat.skills).toBe("js, react");
    expect(flat.languages).toBe("English, Mandarin");
  });

  test("falls back to apply_position when current job has no title", () => {
    const flat = flattenResumeForFill({
      intent: { apply_position: "PM" },
      experience: [{ company: "Acme" }]
    });
    expect(flat.current_title).toBe("PM");
  });

  test("returns blank strings for missing sections without throwing", () => {
    const flat = flattenResumeForFill({});
    expect(flat.edu_school).toBe("");
    expect(flat.current_company).toBe("");
    expect(flat.skills).toBe("");
  });
});
