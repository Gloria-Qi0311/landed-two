require("../schema.js");

const {
  RESUME_SCHEMA,
  SCHEMA_MIGRATIONS,
  applyMigrations,
  normalizeResume,
} = window;

describe("MIGRATIONS registry", () => {
  test("is contiguous from v1 up to current schema version", () => {
    expect(SCHEMA_MIGRATIONS.length).toBeGreaterThan(0);
    let expected = 1;
    for (const m of SCHEMA_MIGRATIONS) {
      expect(m.from).toBe(expected);
      expect(m.to).toBe(expected + 1);
      expect(typeof m.migrate).toBe("function");
      expected = m.to;
    }
    expect(expected).toBe(RESUME_SCHEMA.version);
  });
});

describe("applyMigrations — v1 → v2", () => {
  test("adds englishName / chineseName fields with empty defaults", () => {
    const v1 = { version: 1, basic: { name: "Alice" } };
    const v2 = applyMigrations(JSON.parse(JSON.stringify(v1)));
    expect(v2.version).toBe(2);
    expect(v2.basic.englishName).toBeDefined();
    expect(v2.basic.chineseName).toBeDefined();
  });

  test("backfills englishName from a pure-Latin name", () => {
    const v2 = applyMigrations({ version: 1, basic: { name: "Alice Wong" } });
    expect(v2.basic.englishName).toBe("Alice Wong");
    expect(v2.basic.chineseName).toBe("");
  });

  test("backfills chineseName from a pure-CJK name", () => {
    const v2 = applyMigrations({ version: 1, basic: { name: "王安然" } });
    expect(v2.basic.chineseName).toBe("王安然");
    expect(v2.basic.englishName).toBe("");
  });

  test("splits a mixed CJK + Latin name into both fields", () => {
    const v2 = applyMigrations({ version: 1, basic: { name: "王安然 Alice Wong" } });
    expect(v2.basic.chineseName).toBe("王安然");
    expect(v2.basic.englishName).toBe("Alice Wong");
  });

  test("preserves basic.name (does not delete it)", () => {
    const v2 = applyMigrations({ version: 1, basic: { name: "Alice" } });
    expect(v2.basic.name).toBe("Alice");
  });

  test("does not overwrite englishName / chineseName when already set", () => {
    const v2 = applyMigrations({
      version: 1,
      basic: { name: "Alice Wong", englishName: "AW", chineseName: "" },
    });
    expect(v2.basic.englishName).toBe("AW");
  });

  test("treats data without a version field as v1", () => {
    const v2 = applyMigrations({ basic: { name: "王安然" } });
    expect(v2.version).toBe(2);
    expect(v2.basic.chineseName).toBe("王安然");
  });

  test("is idempotent on already-v2 data", () => {
    const v2input = {
      version: 2,
      basic: { name: "Alice", englishName: "Alice", chineseName: "" },
    };
    const v2out = applyMigrations(JSON.parse(JSON.stringify(v2input)));
    expect(v2out).toEqual(v2input);
  });

  test("does nothing on null / non-object input", () => {
    expect(applyMigrations(null)).toBeNull();
    expect(applyMigrations(undefined)).toBeUndefined();
    expect(applyMigrations("string")).toBe("string");
  });

  test("creates basic if missing", () => {
    const v2 = applyMigrations({ version: 1 });
    expect(v2.version).toBe(2);
    expect(v2.basic).toBeDefined();
    expect(v2.basic.englishName).toBe("");
  });
});

describe("normalizeResume integrates migration", () => {
  test("v1 input emerges as v2 with backfilled fields", () => {
    const out = normalizeResume({
      version: 1,
      basic: { name: "王安然 Alice", email: "alice@example.com" },
    });
    expect(out.version).toBe(2);
    expect(out.basic.chineseName).toBe("王安然");
    expect(out.basic.englishName).toBe("Alice");
    expect(out.basic.email).toBe("alice@example.com");
  });

  test("legacy flat schema goes through upgradeLegacy then v1→v2", () => {
    // upgradeLegacy converts {name, email, ...} flat → structured v1,
    // then applyMigrations bumps to v2.
    const out = normalizeResume({
      name: "Bob Smith",
      email: "bob@example.com",
      edu_school: "MIT",
    });
    expect(out.version).toBe(2);
    expect(out.basic.name).toBe("Bob Smith");
    expect(out.basic.englishName).toBe("Bob Smith");
    expect(out.education[0].school).toBe("MIT");
  });

  test("empty input returns a v2 empty resume", () => {
    const out = normalizeResume(undefined);
    expect(out.version).toBe(2);
    expect(out.basic.name).toBe("");
    expect(out.basic.englishName).toBe("");
  });
});

describe("Migration failure tolerance", () => {
  test("a throwing migration leaves data untouched and continues", () => {
    // Temporarily inject a throwing migration to validate the catch path.
    const original = SCHEMA_MIGRATIONS.slice();
    const origWarn = console.warn;
    console.warn = jest.fn();
    try {
      SCHEMA_MIGRATIONS.length = 0;
      SCHEMA_MIGRATIONS.push({
        from: 1,
        to: 2,
        migrate: () => {
          throw new Error("boom");
        },
      });
      const data = { version: 1, basic: { name: "Alice" } };
      const out = applyMigrations(data);
      // version stays 1 because migration threw
      expect(out.version).toBe(1);
      expect(out.basic.name).toBe("Alice");
      expect(console.warn).toHaveBeenCalled();
    } finally {
      SCHEMA_MIGRATIONS.length = 0;
      original.forEach((m) => SCHEMA_MIGRATIONS.push(m));
      console.warn = origWarn;
    }
  });
});
