require("../lib/cross-lingual.js");

const CL = window.ResumeFillerCrossLingual;

describe("isChineseString / isLatinString", () => {
  test("detects Chinese characters", () => {
    expect(CL.isChineseString("王安然")).toBe(true);
    expect(CL.isChineseString("Alice")).toBe(false);
    expect(CL.isChineseString("Alice 王")).toBe(true);
    expect(CL.isChineseString("")).toBe(false);
  });

  test("isLatinString rejects strings with any CJK", () => {
    expect(CL.isLatinString("Alice")).toBe(true);
    expect(CL.isLatinString("Alice 王")).toBe(false);
    expect(CL.isLatinString("王安然")).toBe(false);
    expect(CL.isLatinString("123")).toBe(false);
  });
});

describe("splitChineseName", () => {
  test("single-character surname (default)", () => {
    expect(CL.splitChineseName("王安然")).toEqual({ lastName: "王", firstName: "安然" });
    expect(CL.splitChineseName("张伟")).toEqual({ lastName: "张", firstName: "伟" });
  });

  test("compound surname 欧阳", () => {
    expect(CL.splitChineseName("欧阳修")).toEqual({ lastName: "欧阳", firstName: "修" });
  });

  test("compound surname 司马", () => {
    expect(CL.splitChineseName("司马懿")).toEqual({ lastName: "司马", firstName: "懿" });
  });

  test("compound surname 上官 with two-char given name", () => {
    expect(CL.splitChineseName("上官婉儿")).toEqual({ lastName: "上官", firstName: "婉儿" });
  });

  test("returns empty object for non-CJK input", () => {
    expect(CL.splitChineseName("Alice")).toEqual({ firstName: "", lastName: "" });
    expect(CL.splitChineseName("")).toEqual({ firstName: "", lastName: "" });
  });

  test("handles compound surname that equals the full name (no first name)", () => {
    // 欧阳 alone: no characters left after the surname → fall back to first-char split
    expect(CL.splitChineseName("欧阳")).toEqual({ lastName: "欧", firstName: "阳" });
  });
});

describe("splitEnglishName", () => {
  test("first + last", () => {
    expect(CL.splitEnglishName("Alice Wong")).toEqual({ firstName: "Alice", lastName: "Wong" });
  });

  test("middle name → grouped into firstName", () => {
    expect(CL.splitEnglishName("Alice Mary Wong")).toEqual({ firstName: "Alice Mary", lastName: "Wong" });
  });

  test("single name → firstName only", () => {
    expect(CL.splitEnglishName("Alice")).toEqual({ firstName: "Alice", lastName: "" });
  });

  test("empty input", () => {
    expect(CL.splitEnglishName("")).toEqual({ firstName: "", lastName: "" });
    expect(CL.splitEnglishName("   ")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("splitName (auto-detect)", () => {
  test("dispatches to Chinese split for CJK input", () => {
    expect(CL.splitName("王安然")).toEqual({ lastName: "王", firstName: "安然" });
  });

  test("dispatches to English split for Latin input", () => {
    expect(CL.splitName("Alice Wong")).toEqual({ firstName: "Alice", lastName: "Wong" });
  });

  test("falls back to English split for mixed-language input", () => {
    // Caller should pass englishName / chineseName explicitly for cleaner split.
    expect(CL.splitName("王 Alice")).toEqual({ firstName: "王", lastName: "Alice" });
  });
});

describe("translateDegree", () => {
  test("English → Chinese", () => {
    expect(CL.translateDegree("Bachelor", "zh")).toBe("学士");
    expect(CL.translateDegree("BS", "zh")).toBe("学士");
    expect(CL.translateDegree("master's degree", "zh")).toBe("硕士");
    expect(CL.translateDegree("PhD", "zh")).toBe("博士");
  });

  test("Chinese → English", () => {
    expect(CL.translateDegree("学士", "en")).toBe("Bachelor's");
    expect(CL.translateDegree("硕士", "en")).toBe("Master's");
    expect(CL.translateDegree("博士", "en")).toBe("PhD");
    expect(CL.translateDegree("MBA", "en")).toBe("MBA");
  });

  test("returns null for unknown values", () => {
    expect(CL.translateDegree("Wizard", "zh")).toBeNull();
    expect(CL.translateDegree("巫师", "en")).toBeNull();
  });
});

describe("translateSchool", () => {
  test("Chinese → English on top-30 universities", () => {
    expect(CL.translateSchool("清华大学", "en")).toBe("Tsinghua University");
    expect(CL.translateSchool("北京大学", "en")).toBe("Peking University");
    expect(CL.translateSchool("复旦大学", "en")).toBe("Fudan University");
    expect(CL.translateSchool("浙江大学", "en")).toBe("Zhejiang University");
    expect(CL.translateSchool("中国人民大学", "en")).toBe("Renmin University of China");
  });

  test("English → Chinese (case-insensitive)", () => {
    expect(CL.translateSchool("Tsinghua University", "zh")).toBe("清华大学");
    expect(CL.translateSchool("PEKING UNIVERSITY", "zh")).toBe("北京大学");
  });

  test("returns null for unknown schools", () => {
    expect(CL.translateSchool("某不知名大学", "en")).toBeNull();
    expect(CL.translateSchool("Hogwarts", "zh")).toBeNull();
  });

  test("provides 30+ entries (issue #6 acceptance)", () => {
    expect(CL.SCHOOLS.length).toBeGreaterThanOrEqual(30);
  });
});

describe("translateCompany", () => {
  test("Chinese → English on top-30 companies", () => {
    expect(CL.translateCompany("字节跳动", "en")).toBe("ByteDance");
    expect(CL.translateCompany("腾讯", "en")).toBe("Tencent");
    expect(CL.translateCompany("阿里巴巴", "en")).toBe("Alibaba");
    expect(CL.translateCompany("美团", "en")).toBe("Meituan");
    expect(CL.translateCompany("小米", "en")).toBe("Xiaomi");
  });

  test("aliases route to the canonical English name", () => {
    expect(CL.translateCompany("阿里", "en")).toBe("Alibaba");
    expect(CL.translateCompany("字节", "en")).toBe("ByteDance");
    expect(CL.translateCompany("B站", "en")).toBe("Bilibili");
    expect(CL.translateCompany("哔哩哔哩", "en")).toBe("Bilibili");
  });

  test("English → Chinese", () => {
    expect(CL.translateCompany("ByteDance", "zh")).toBe("字节跳动");
    expect(CL.translateCompany("Alibaba", "zh")).toBe("阿里巴巴");
  });

  test("returns null for unknown companies", () => {
    expect(CL.translateCompany("某不知名公司", "en")).toBeNull();
    expect(CL.translateCompany("ACME Corp", "zh")).toBeNull();
  });

  test("provides 30+ entries", () => {
    expect(CL.COMPANIES.length).toBeGreaterThanOrEqual(30);
  });
});

describe("maybeTranslate (the fill-time hook)", () => {
  test("Chinese resume value + English form label → translates to English", () => {
    expect(
      CL.maybeTranslate("edu_school", "清华大学", "University attended")
    ).toBe("Tsinghua University");
    expect(
      CL.maybeTranslate("current_company", "字节跳动", "Most recent employer")
    ).toBe("ByteDance");
    expect(
      CL.maybeTranslate("edu_degree", "硕士", "Highest degree")
    ).toBe("Master's");
  });

  test("English resume value + Chinese form label → translates to Chinese", () => {
    expect(
      CL.maybeTranslate("edu_school", "Peking University", "毕业院校")
    ).toBe("北京大学");
    expect(
      CL.maybeTranslate("current_company", "Tencent", "公司名称")
    ).toBe("腾讯");
    expect(
      CL.maybeTranslate("edu_degree", "PhD", "学位")
    ).toBe("博士");
  });

  test("same-language label and value → returns original (no-op)", () => {
    expect(
      CL.maybeTranslate("edu_school", "Tsinghua University", "University attended")
    ).toBe("Tsinghua University");
    expect(
      CL.maybeTranslate("edu_school", "清华大学", "毕业院校")
    ).toBe("清华大学");
  });

  test("unknown value → returns original (preserves user content)", () => {
    expect(
      CL.maybeTranslate("edu_school", "某不知名大学", "University attended")
    ).toBe("某不知名大学");
    expect(
      CL.maybeTranslate("current_company", "ACME Corp", "公司名称")
    ).toBe("ACME Corp");
  });

  test("non-translatable resume keys → returns original", () => {
    expect(
      CL.maybeTranslate("email", "alice@example.com", "邮箱")
    ).toBe("alice@example.com");
    expect(
      CL.maybeTranslate("phone", "13800138000", "Phone")
    ).toBe("13800138000");
  });

  test("missing label or value → returns original", () => {
    expect(CL.maybeTranslate("edu_school", "清华大学", "")).toBe("清华大学");
    expect(CL.maybeTranslate("edu_school", "", "University")).toBe("");
  });
});
