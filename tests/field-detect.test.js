require("../lib/field-detect.js");

const FD = window.ResumeFillerFieldDetect;

beforeEach(() => {
  document.body.innerHTML = "";
  FD.registerFallback(null);
});

describe("normalize / normalizeSpaced / isCJKKey", () => {
  test("normalize lowercases and strips spaces, hyphens, underscores, dots", () => {
    expect(FD.normalize("First_Name")).toBe("firstname");
    expect(FD.normalize("e-mail")).toBe("email");
    expect(FD.normalize("URL.address")).toBe("urladdress");
    expect(FD.normalize("  Tel No  ")).toBe("telno");
  });

  test("normalize handles falsy input", () => {
    expect(FD.normalize(undefined)).toBe("");
    expect(FD.normalize(null)).toBe("");
    expect(FD.normalize("")).toBe("");
  });

  test("normalizeSpaced collapses whitespace but preserves word boundaries", () => {
    expect(FD.normalizeSpaced("First_Name")).toBe("first name");
    expect(FD.normalizeSpaced("Years   of  Experience")).toBe("years of experience");
    expect(FD.normalizeSpaced("e-mail")).toBe("e mail");
  });

  test("isCJKKey detects CJK characters", () => {
    expect(FD.isCJKKey("姓名")).toBe(true);
    expect(FD.isCJKKey("姓")).toBe(true);
    expect(FD.isCJKKey("name")).toBe(false);
    expect(FD.isCJKKey("")).toBe(false);
    expect(FD.isCJKKey("name 姓名")).toBe(true);
  });
});

describe("getFieldLabel", () => {
  test("reads label[for]", () => {
    document.body.innerHTML = `
      <label for="email-field">Email Address</label>
      <input id="email-field" />
    `;
    const el = document.getElementById("email-field");
    expect(FD.getFieldLabel(el)).toBe("Email Address");
  });

  test("falls back to aria-label when no label[for]", () => {
    document.body.innerHTML = `<input aria-label="Phone number" />`;
    expect(FD.getFieldLabel(document.querySelector("input"))).toBe("Phone number");
  });

  test("resolves aria-labelledby", () => {
    document.body.innerHTML = `
      <span id="cap">First Name</span>
      <input aria-labelledby="cap" />
    `;
    expect(FD.getFieldLabel(document.querySelector("input"))).toBe("First Name");
  });

  test("walks up to a sibling text container when no aria/label", () => {
    document.body.innerHTML = `
      <div>
        <div>School Name</div>
        <div><input id="x" /></div>
      </div>
    `;
    expect(FD.getFieldLabel(document.getElementById("x"))).toBe("School Name");
  });

  test("falls back to placeholder when nothing else found", () => {
    document.body.innerHTML = `<input placeholder="Your GitHub" />`;
    expect(FD.getFieldLabel(document.querySelector("input"))).toBe("Your GitHub");
  });

  test("falls back to name then id when no other signal exists", () => {
    document.body.innerHTML = `<input name="just_a_name" />`;
    expect(FD.getFieldLabel(document.querySelector("input"))).toBe("just_a_name");
  });

  test("ignores sibling containers that themselves contain inputs", () => {
    document.body.innerHTML = `
      <div>
        <div><input id="other" /></div>
        <div><input id="me" /></div>
      </div>
    `;
    // No standalone text label, no aria, no placeholder, no name → falls back to id
    expect(FD.getFieldLabel(document.getElementById("me"))).toBe("me");
  });
});

describe("matchResumeKey — basic mapping", () => {
  function makeInput(html) {
    document.body.innerHTML = html;
    return document.querySelector("input");
  }

  test("matches email via label", () => {
    const el = makeInput(`<label for="e">Email</label><input id="e" />`);
    const r = FD.matchResumeKey(el);
    expect(r.key).toBe("email");
    expect(r.source).toBe("label");
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  test("matches phone via Chinese label (CJK path)", () => {
    const el = makeInput(`<label for="p">手机号</label><input id="p" />`);
    expect(FD.matchResumeKey(el).key).toBe("phone");
  });

  test("matches via aria-label when no <label>", () => {
    const el = makeInput(`<input aria-label="LinkedIn" />`);
    const r = FD.matchResumeKey(el);
    expect(r.key).toBe("linkedin");
    expect(r.source).toBe("aria-label");
  });

  test("matches via placeholder fallback", () => {
    const el = makeInput(`<input placeholder="GitHub URL" />`);
    expect(FD.matchResumeKey(el).key).toBe("github");
  });

  test("returns null when nothing matches", () => {
    const el = makeInput(`<input placeholder="random gibberish" />`);
    expect(FD.matchResumeKey(el)).toBeNull();
  });
});

describe("matchResumeKey — name context blocking", () => {
  function makeInput(html) {
    document.body.innerHTML = html;
    return document.querySelector("input");
  }

  test("does not map company name as person name (Latin)", () => {
    const el = makeInput(`<label for="c">Company Name</label><input id="c" />`);
    const r = FD.matchResumeKey(el);
    // The 'company' rule should win, NOT the 'name' rule
    expect(r.key).toBe("current_company");
  });

  test("does not map school name as person name (Latin)", () => {
    const el = makeInput(`<label for="s">School name</label><input id="s" />`);
    expect(FD.matchResumeKey(el).key).toBe("edu_school");
  });

  test("does not map 公司名称 as person name (CJK)", () => {
    const el = makeInput(`<label for="c">公司名称</label><input id="c" />`);
    expect(FD.matchResumeKey(el).key).toBe("current_company");
  });

  test("does not map 项目名称 as person name (CJK)", () => {
    const el = makeInput(`<label for="p">项目名称</label><input id="p" />`);
    expect(FD.matchResumeKey(el).key).toBe("project_name");
  });

  test("legitimate full-name field still matches", () => {
    const el = makeInput(`<label for="n">Full Name</label><input id="n" />`);
    expect(FD.matchResumeKey(el).key).toBe("name");
  });
});

describe("matchResumeKey — confidence reflects source", () => {
  function makeInput(html) {
    document.body.innerHTML = html;
    return document.querySelector("input");
  }

  test("label match is higher confidence than id match", () => {
    const labelMatch = FD.matchResumeKey(
      makeInput(`<label for="x">Email</label><input id="x" />`)
    );
    const idMatch = FD.matchResumeKey(
      makeInput(`<input id="email" />`)
    );
    expect(labelMatch.confidence).toBeGreaterThan(idMatch.confidence);
  });

  test("aria-label match is higher confidence than placeholder match", () => {
    const ariaMatch = FD.matchResumeKey(makeInput(`<input aria-label="GitHub" />`));
    const phMatch = FD.matchResumeKey(makeInput(`<input placeholder="GitHub" />`));
    expect(ariaMatch.confidence).toBeGreaterThan(phMatch.confidence);
  });
});

describe("registerFallback", () => {
  function makeInput(html) {
    document.body.innerHTML = html;
    return document.querySelector("input");
  }

  test("fallback runs only when no rule matches", () => {
    const fallback = jest.fn(() => ({ key: "summary" }));
    FD.registerFallback(fallback);

    // Rule matches → fallback not called
    FD.matchResumeKey(makeInput(`<input aria-label="Email" />`));
    expect(fallback).not.toHaveBeenCalled();

    // No rule matches → fallback called
    const r = FD.matchResumeKey(makeInput(`<input aria-label="Mystery field" />`));
    expect(fallback).toHaveBeenCalled();
    expect(r.key).toBe("summary");
    expect(r.source).toBe("fallback");
  });

  test("fallback returning null leaves the result as null", () => {
    FD.registerFallback(() => null);
    const r = FD.matchResumeKey(makeInput(`<input aria-label="Mystery field" />`));
    expect(r).toBeNull();
  });

  test("fallback throwing does not break filling", () => {
    FD.registerFallback(() => {
      throw new Error("LLM down");
    });
    const r = FD.matchResumeKey(makeInput(`<input aria-label="Mystery field" />`));
    expect(r).toBeNull();
  });

  test("registerFallback with non-function clears the fallback", () => {
    FD.registerFallback(() => ({ key: "summary" }));
    FD.registerFallback(null);
    const r = FD.matchResumeKey(makeInput(`<input aria-label="Mystery field" />`));
    expect(r).toBeNull();
  });
});
