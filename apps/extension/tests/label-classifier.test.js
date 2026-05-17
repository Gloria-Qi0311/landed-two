require("../lib/label-classifier.js");

const LC = window.ResumeFillerLabelClassifier;

describe("inferSection", () => {
  test("basic section: name / email / phone / linkedin", () => {
    expect(LC.inferSection("First Name")).toBe("basic");
    expect(LC.inferSection("Email Address")).toBe("basic");
    expect(LC.inferSection("Phone Number")).toBe("basic");
    expect(LC.inferSection("LinkedIn URL")).toBe("basic");
    expect(LC.inferSection("姓名")).toBe("basic");
    expect(LC.inferSection("邮箱")).toBe("basic");
  });

  test("education section: school / degree / major / GPA", () => {
    expect(LC.inferSection("University attended")).toBe("education");
    expect(LC.inferSection("Highest degree")).toBe("education");
    expect(LC.inferSection("Field of Study")).toBe("education");
    expect(LC.inferSection("GPA")).toBe("education");
    expect(LC.inferSection("毕业院校")).toBe("education");
    expect(LC.inferSection("专业")).toBe("education");
  });

  test("experience section: company / title / salary / visa", () => {
    expect(LC.inferSection("Current Company")).toBe("experience");
    expect(LC.inferSection("Job Title")).toBe("experience");
    expect(LC.inferSection("Expected Salary")).toBe("experience");
    expect(LC.inferSection("Visa Sponsorship?")).toBe("experience");
    expect(LC.inferSection("Years of Experience")).toBe("experience");
    expect(LC.inferSection("当前公司")).toBe("experience");
    expect(LC.inferSection("期望薪资")).toBe("experience");
  });

  test("projects section", () => {
    expect(LC.inferSection("Project Name")).toBe("projects");
    expect(LC.inferSection("项目描述")).toBe("projects");
  });

  test("skills section", () => {
    expect(LC.inferSection("Tech Stack")).toBe("skills");
    expect(LC.inferSection("Skills")).toBe("skills");
    expect(LC.inferSection("技能")).toBe("skills");
  });

  test("languages section", () => {
    expect(LC.inferSection("Language Proficiency")).toBe("languages");
    expect(LC.inferSection("Spoken languages")).toBe("languages");
    expect(LC.inferSection("语言能力")).toBe("languages");
  });

  test("other for unrecognized labels", () => {
    expect(LC.inferSection("How did you hear about us?")).toBe("other");
    expect(LC.inferSection("Pronouns")).toBe("other");
    expect(LC.inferSection("")).toBe("other");
  });

  test("normalization handles spaces / underscores / hyphens / case", () => {
    expect(LC.inferSection("EMAIL_ADDRESS")).toBe("basic");
    expect(LC.inferSection("Job-Title")).toBe("experience");
    expect(LC.inferSection("first.name")).toBe("basic");
  });
});

describe("groupBySection", () => {
  test("groups items into preferred section order", () => {
    const items = [
      { label: "Visa Sponsorship?" },
      { label: "Email" },
      { label: "GPA" },
      { label: "Pronouns" },
      { label: "Project Name" },
    ];
    const groups = LC.groupBySection(items);
    const sections = groups.map((g) => g.section);
    expect(sections).toEqual(["basic", "education", "experience", "projects", "other"]);
  });

  test("preserves item order within each section", () => {
    const items = [
      { label: "Email" },
      { label: "Phone" },
      { label: "LinkedIn" },
    ];
    const groups = LC.groupBySection(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.label)).toEqual(["Email", "Phone", "LinkedIn"]);
  });

  test("empty input returns empty array", () => {
    expect(LC.groupBySection([])).toEqual([]);
    expect(LC.groupBySection(undefined)).toEqual([]);
  });
});

describe("RESUME_KEY_OPTIONS", () => {
  test("covers every resume key referenced by content.js FIELD_MAP", () => {
    const expectedKeys = [
      "name", "firstName", "lastName", "email", "phone", "wechat",
      "location", "linkedin", "github", "portfolio",
      "edu_school", "edu_major", "edu_degree", "edu_gpa",
      "apply_position", "salary", "available_date", "years_exp",
      "current_company", "current_title", "job_description",
      "skills", "languages", "summary",
      "project_name", "project_description",
    ];
    const presentKeys = LC.RESUME_KEY_OPTIONS.map((o) => o.key);
    for (const k of expectedKeys) {
      expect(presentKeys).toContain(k);
    }
  });

  test("each entry has both English and Chinese labels", () => {
    for (const opt of LC.RESUME_KEY_OPTIONS) {
      expect(typeof opt.labelEn).toBe("string");
      expect(opt.labelEn.length).toBeGreaterThan(0);
      expect(typeof opt.labelZh).toBe("string");
      expect(opt.labelZh.length).toBeGreaterThan(0);
    }
  });
});
