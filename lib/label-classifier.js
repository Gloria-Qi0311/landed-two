// lib/label-classifier.js — bucket unmatched form labels by resume section
//
// Used by popup step 3 (#10) to group the unmatched-fields list under
// "Basic Info / Education / Experience / Projects / Other" headers.
// Pure functions; no DOM, no chrome.* deps. Loaded by popup.html and
// directly required by tests.
//
// Exposes window.ResumeFillerLabelClassifier.

(function (global) {
  // Each bucket lists keyword fragments (lowercased, normalized for
  // whitespace/punct) that mark a label as belonging to that section.
  // Order matters: the first matching bucket wins. Narrower / more
  // specific buckets go first because broad keywords like "name" appear
  // in many contexts ("Project Name", "Company Name", "First Name").
  // Putting "basic" last means "name" only catches when no other
  // section's keyword has fired.
  const BUCKETS = [
    {
      section: "projects",
      en: ["project"],
      zh: ["项目"],
    },
    {
      section: "education",
      en: ["school", "university", "college", "institution", "degree", "major", "field of study", "gpa", "graduation", "education"],
      zh: ["学校", "院校", "大学", "学历", "学位", "专业", "绩点", "毕业", "教育"],
    },
    {
      section: "experience",
      en: ["company", "employer", "organization", "job title", "position", "role", "responsibilities", "duties", "salary", "compensation", "expected", "available", "notice", "years of experience", "years exp", "work authorization", "visa", "sponsor"],
      zh: ["公司", "单位", "雇主", "职位", "岗位", "职责", "薪资", "薪酬", "工资", "到岗", "入职", "工作年限", "经验", "签证", "授权"],
    },
    {
      section: "skills",
      en: ["skill", "stack", "technology", "tech stack", "tool"],
      zh: ["技能", "技术栈", "工具"],
    },
    {
      section: "languages",
      en: ["language proficiency", "language", "spoken", "fluency"],
      zh: ["语言", "语种", "口语"],
    },
    {
      section: "basic",
      en: ["name", "email", "phone", "wechat", "address", "city", "linkedin", "github", "portfolio", "website", "url", "contact"],
      zh: ["姓名", "名字", "邮箱", "电话", "手机", "微信", "地址", "城市", "所在地", "链接", "联系"],
    },
  ];

  function normalize(s) {
    return String(s || "").toLowerCase().replace(/[\s_\-.]/g, "");
  }

  // Returns one of: basic | education | experience | projects | skills | languages | other
  function inferSection(label) {
    const norm = normalize(label);
    if (!norm) return "other";
    for (const bucket of BUCKETS) {
      for (const kw of bucket.en) {
        if (norm.includes(normalize(kw))) return bucket.section;
      }
      for (const kw of bucket.zh) {
        if (label.includes(kw)) return bucket.section;
      }
    }
    return "other";
  }

  function groupBySection(items) {
    const groups = {};
    const order = [];
    for (const item of items || []) {
      const section = inferSection(item.label || "");
      if (!groups[section]) {
        groups[section] = [];
        order.push(section);
      }
      groups[section].push(item);
    }
    // Stable preferred display order, with anything unexpected appended.
    const preferred = ["basic", "education", "experience", "projects", "skills", "languages", "other"];
    const sorted = preferred.filter((s) => groups[s]).concat(order.filter((s) => !preferred.includes(s)));
    return sorted.map((section) => ({ section, items: groups[section] }));
  }

  // Resume keys the "Map to field" dropdown lets users target. Each
  // entry's `key` lines up with content.js's flatten map (matches the
  // resumeKey used by FIELD_MAP), so popup → labelMappings → content.js
  // doesn't need a translation layer.
  const RESUME_KEY_OPTIONS = [
    { section: "basic", key: "name", labelEn: "Full name", labelZh: "姓名（全名）" },
    { section: "basic", key: "firstName", labelEn: "First name", labelZh: "名 First Name" },
    { section: "basic", key: "lastName", labelEn: "Last name", labelZh: "姓 Last Name" },
    { section: "basic", key: "englishName", labelEn: "English name", labelZh: "英文名" },
    { section: "basic", key: "chineseName", labelEn: "Chinese name", labelZh: "中文名" },
    { section: "basic", key: "email", labelEn: "Email", labelZh: "邮箱" },
    { section: "basic", key: "phone", labelEn: "Phone", labelZh: "手机" },
    { section: "basic", key: "wechat", labelEn: "WeChat", labelZh: "微信" },
    { section: "basic", key: "location", labelEn: "Location", labelZh: "所在城市" },
    { section: "basic", key: "linkedin", labelEn: "LinkedIn", labelZh: "LinkedIn" },
    { section: "basic", key: "github", labelEn: "GitHub", labelZh: "GitHub" },
    { section: "basic", key: "portfolio", labelEn: "Portfolio", labelZh: "个人网站" },
    { section: "intent", key: "apply_position", labelEn: "Position applied for", labelZh: "应聘职位" },
    { section: "intent", key: "salary", labelEn: "Expected salary", labelZh: "期望薪资" },
    { section: "intent", key: "available_date", labelEn: "Available start date", labelZh: "最早到岗" },
    { section: "intent", key: "years_exp", labelEn: "Years of experience", labelZh: "工作年限" },
    { section: "education", key: "edu_school", labelEn: "School", labelZh: "学校" },
    { section: "education", key: "edu_major", labelEn: "Major", labelZh: "专业" },
    { section: "education", key: "edu_degree", labelEn: "Degree", labelZh: "学历" },
    { section: "education", key: "edu_gpa", labelEn: "GPA", labelZh: "绩点" },
    { section: "experience", key: "current_company", labelEn: "Current company", labelZh: "公司" },
    { section: "experience", key: "current_title", labelEn: "Current title", labelZh: "职位" },
    { section: "experience", key: "job_description", labelEn: "Job description", labelZh: "工作职责" },
    { section: "projects", key: "project_name", labelEn: "Project name", labelZh: "项目名称" },
    { section: "projects", key: "project_description", labelEn: "Project description", labelZh: "项目描述" },
    { section: "skills", key: "skills", labelEn: "Skills (joined)", labelZh: "技能（合并）" },
    { section: "languages", key: "languages", labelEn: "Languages (joined)", labelZh: "语言（合并）" },
    { section: "summary", key: "summary", labelEn: "Summary", labelZh: "自我介绍" },
  ];

  global.ResumeFillerLabelClassifier = {
    inferSection,
    groupBySection,
    BUCKETS,
    RESUME_KEY_OPTIONS,
  };
})(typeof window !== "undefined" ? window : globalThis);
