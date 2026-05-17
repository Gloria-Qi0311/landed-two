// lib/cross-lingual.js — bilingual mapping for cross-border applicants
//
// Highest-frequency cross-border pain point: resume in Chinese / form in
// English (applying to US jobs), or vice versa. This module provides:
//
//   - Chinese name splitting (with compound-surname awareness)
//   - English name splitting (Last = final word)
//   - Degree translation (Bachelor ↔ 学士, MS ↔ 硕士, ...)
//   - School translation table (top-30+ Chinese universities)
//   - Company translation table (top-30+ Chinese tech / finance / media)
//   - maybeTranslate(resumeKey, value, label) — the translate-on-fill
//     hook that content.js calls when the form label's language differs
//     from the value's language.
//
// Loaded after lib/value-match.js and before content.js.
// Exposes window.ResumeFillerCrossLingual.

(function (global) {
  // Compound (≥2-char) Chinese surnames. Single-char surnames are the
  // default fallback. Order matters: longer prefixes are checked first
  // so 司马 isn't mistaken for 司 + 马later.
  const COMPOUND_SURNAMES_CJK = [
    "欧阳", "司马", "司徒", "诸葛", "上官", "夏侯", "皇甫", "尉迟",
    "公孙", "令狐", "慕容", "宇文", "长孙", "南宫", "东方", "西门",
    "澹台", "公冶", "宗政", "濮阳", "淳于", "单于", "太叔", "申屠",
    "钟离", "闾丘", "司空", "拓跋", "赫连",
  ];

  // English (lowercased) → Chinese degree text used by typical Chinese forms.
  const DEGREE_TO_ZH = {
    "bachelor": "学士",
    "bachelors": "学士",
    "bachelor's": "学士",
    "bachelor's degree": "学士",
    "bs": "学士",
    "b.s.": "学士",
    "ba": "学士",
    "b.a.": "学士",
    "bsc": "学士",
    "undergraduate": "本科",
    "master": "硕士",
    "masters": "硕士",
    "master's": "硕士",
    "master's degree": "硕士",
    "ms": "硕士",
    "m.s.": "硕士",
    "ma": "硕士",
    "m.a.": "硕士",
    "msc": "硕士",
    "mba": "MBA",
    "phd": "博士",
    "ph.d.": "博士",
    "doctorate": "博士",
    "doctoral": "博士",
    "associate": "专科",
    "associate's": "专科",
    "associate's degree": "专科",
    "high school": "高中",
    "high school diploma": "高中",
  };

  // Chinese → English degree text used by typical US/SG/UK forms.
  const DEGREE_TO_EN = {
    "学士": "Bachelor's",
    "学士学位": "Bachelor's",
    "本科": "Bachelor's",
    "硕士": "Master's",
    "硕士学位": "Master's",
    "研究生": "Master's",
    "MBA": "MBA",
    "工商管理硕士": "MBA",
    "博士": "PhD",
    "博士学位": "PhD",
    "专科": "Associate's",
    "大专": "Associate's",
    "副学士": "Associate's",
    "高中": "High School",
  };

  // Top Chinese universities (Project 985/211 + popular). Pairs are
  // [Chinese, English]. Add to this list as #6 follow-ups land.
  const SCHOOLS = [
    ["清华大学", "Tsinghua University"],
    ["北京大学", "Peking University"],
    ["复旦大学", "Fudan University"],
    ["上海交通大学", "Shanghai Jiao Tong University"],
    ["浙江大学", "Zhejiang University"],
    ["中国科学技术大学", "University of Science and Technology of China"],
    ["南京大学", "Nanjing University"],
    ["同济大学", "Tongji University"],
    ["武汉大学", "Wuhan University"],
    ["中山大学", "Sun Yat-sen University"],
    ["哈尔滨工业大学", "Harbin Institute of Technology"],
    ["西安交通大学", "Xi'an Jiaotong University"],
    ["北京航空航天大学", "Beihang University"],
    ["北京师范大学", "Beijing Normal University"],
    ["华中科技大学", "Huazhong University of Science and Technology"],
    ["南开大学", "Nankai University"],
    ["天津大学", "Tianjin University"],
    ["东南大学", "Southeast University"],
    ["四川大学", "Sichuan University"],
    ["吉林大学", "Jilin University"],
    ["中南大学", "Central South University"],
    ["湖南大学", "Hunan University"],
    ["厦门大学", "Xiamen University"],
    ["山东大学", "Shandong University"],
    ["中国人民大学", "Renmin University of China"],
    ["对外经济贸易大学", "University of International Business and Economics"],
    ["北京理工大学", "Beijing Institute of Technology"],
    ["电子科技大学", "University of Electronic Science and Technology of China"],
    ["北京邮电大学", "Beijing University of Posts and Telecommunications"],
    ["南京理工大学", "Nanjing University of Science and Technology"],
    ["华东师范大学", "East China Normal University"],
    ["北京交通大学", "Beijing Jiaotong University"],
    ["上海财经大学", "Shanghai University of Finance and Economics"],
    ["中央财经大学", "Central University of Finance and Economics"],
    ["香港大学", "The University of Hong Kong"],
    ["香港中文大学", "The Chinese University of Hong Kong"],
    ["香港科技大学", "The Hong Kong University of Science and Technology"],
    ["香港理工大学", "The Hong Kong Polytechnic University"],
  ];

  // Top Chinese tech / finance / media employers (cross-border applicants
  // most often need these translated for US/EU forms).
  const COMPANIES = [
    ["字节跳动", "ByteDance"],
    ["字节", "ByteDance"],
    ["腾讯", "Tencent"],
    ["腾讯科技", "Tencent"],
    ["阿里巴巴", "Alibaba"],
    ["阿里", "Alibaba"],
    ["百度", "Baidu"],
    ["美团", "Meituan"],
    ["京东", "JD.com"],
    ["滴滴", "DiDi"],
    ["滴滴出行", "DiDi"],
    ["网易", "NetEase"],
    ["小米", "Xiaomi"],
    ["华为", "Huawei"],
    ["拼多多", "Pinduoduo"],
    ["快手", "Kuaishou"],
    ["哔哩哔哩", "Bilibili"],
    ["B站", "Bilibili"],
    ["新浪", "Sina"],
    ["搜狐", "Sohu"],
    ["携程", "Trip.com"],
    ["饿了么", "Ele.me"],
    ["小红书", "Xiaohongshu"],
    ["理想汽车", "Li Auto"],
    ["蔚来", "NIO"],
    ["小鹏汽车", "Xpeng"],
    ["比亚迪", "BYD"],
    ["平安", "Ping An"],
    ["招商银行", "China Merchants Bank"],
    ["中国银行", "Bank of China"],
    ["工商银行", "ICBC"],
    ["建设银行", "China Construction Bank"],
    ["农业银行", "Agricultural Bank of China"],
    ["新华社", "Xinhua News Agency"],
    ["人民日报", "People's Daily"],
    ["央视", "CCTV"],
    ["中国移动", "China Mobile"],
    ["中国联通", "China Unicom"],
    ["中国电信", "China Telecom"],
  ];

  function isChineseString(s) {
    return /[一-鿿]/.test(String(s || ""));
  }

  function isLatinString(s) {
    const str = String(s || "");
    return /[a-zA-Z]/.test(str) && !/[一-鿿]/.test(str);
  }

  // ── Lookup tables built from the lists above ────────────────────────────
  const SCHOOL_ZH_TO_EN = Object.create(null);
  const SCHOOL_EN_TO_ZH = Object.create(null);
  for (const [zh, en] of SCHOOLS) {
    SCHOOL_ZH_TO_EN[zh] = en;
    SCHOOL_EN_TO_ZH[en.toLowerCase()] = zh;
  }

  const COMPANY_ZH_TO_EN = Object.create(null);
  const COMPANY_EN_TO_ZH = Object.create(null);
  for (const [zh, en] of COMPANIES) {
    if (!COMPANY_ZH_TO_EN[zh]) COMPANY_ZH_TO_EN[zh] = en;
    if (!COMPANY_EN_TO_ZH[en.toLowerCase()]) COMPANY_EN_TO_ZH[en.toLowerCase()] = zh;
  }

  function translateSchool(value, targetLang) {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (targetLang === "en") return SCHOOL_ZH_TO_EN[trimmed] || null;
    if (targetLang === "zh") return SCHOOL_EN_TO_ZH[trimmed.toLowerCase()] || null;
    return null;
  }

  function translateCompany(value, targetLang) {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (targetLang === "en") return COMPANY_ZH_TO_EN[trimmed] || null;
    if (targetLang === "zh") return COMPANY_EN_TO_ZH[trimmed.toLowerCase()] || null;
    return null;
  }

  function translateDegree(value, targetLang) {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (targetLang === "zh") return DEGREE_TO_ZH[trimmed.toLowerCase()] || null;
    if (targetLang === "en") return DEGREE_TO_EN[trimmed] || null;
    return null;
  }

  // ── Name splitting ──────────────────────────────────────────────────────
  function splitChineseName(fullName) {
    const name = String(fullName || "").trim();
    if (!name || !isChineseString(name)) return { firstName: "", lastName: "" };
    for (const surname of COMPOUND_SURNAMES_CJK) {
      if (name.startsWith(surname) && name.length > surname.length) {
        return { lastName: surname, firstName: name.slice(surname.length) };
      }
    }
    return { lastName: name[0], firstName: name.slice(1) };
  }

  function splitEnglishName(fullName) {
    const name = String(fullName || "").trim();
    if (!name) return { firstName: "", lastName: "" };
    const parts = name.split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: "" };
    return {
      firstName: parts.slice(0, -1).join(" "),
      lastName: parts[parts.length - 1],
    };
  }

  function splitName(fullName) {
    const name = String(fullName || "").trim();
    if (!name) return { firstName: "", lastName: "" };
    if (isChineseString(name) && !/[a-zA-Z]/.test(name)) return splitChineseName(name);
    if (isLatinString(name)) return splitEnglishName(name);
    // Mixed-language name: caller should pass the language-specific source
    // (englishName or chineseName) instead. Fallback to English split.
    return splitEnglishName(name);
  }

  // ── Translate-on-fill hook ──────────────────────────────────────────────
  // Called by content.js between resume-key resolution and the actual
  // value write. Returns the original value when no translation applies
  // (so callers can default to the raw value).
  function maybeTranslate(resumeKey, value, label) {
    if (!value || !label) return value;
    const labelCJK = isChineseString(label) && !/[a-zA-Z]/.test(label);
    const labelLatin = isLatinString(label);
    if (!labelCJK && !labelLatin) return value;

    const valueCJK = isChineseString(value) && !/[a-zA-Z]/.test(value);
    const valueLatin = isLatinString(value);
    if (!valueCJK && !valueLatin) return value;

    // Only act when label and value are in different languages.
    if ((labelCJK && valueCJK) || (labelLatin && valueLatin)) return value;

    const targetLang = labelCJK ? "zh" : "en";

    switch (resumeKey) {
      case "edu_school":
        return translateSchool(value, targetLang) || value;
      case "current_company":
        return translateCompany(value, targetLang) || value;
      case "edu_degree":
        return translateDegree(value, targetLang) || value;
      default:
        return value;
    }
  }

  global.ResumeFillerCrossLingual = {
    splitName,
    splitChineseName,
    splitEnglishName,
    translateDegree,
    translateSchool,
    translateCompany,
    maybeTranslate,
    isChineseString,
    isLatinString,
    SCHOOLS,
    COMPANIES,
    COMPOUND_SURNAMES_CJK,
  };
})(typeof window !== "undefined" ? window : globalThis);
