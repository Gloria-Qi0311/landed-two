require("../lib/llm-providers.js");

const LP = window.ResumeFillerLLMProviders;

describe("listProviders / getProvider", () => {
  test("lists the five expected providers", () => {
    const ids = LP.listProviders().map((p) => p.id).sort();
    expect(ids).toEqual(["anthropic", "custom", "deepseek", "doubao", "openai"]);
  });

  test("getProvider returns the provider object by id", () => {
    expect(LP.getProvider("openai").name).toBe("OpenAI");
    expect(LP.getProvider("anthropic").defaultModel).toMatch(/claude/);
    expect(LP.getProvider("doubao").defaultEndpoint).toMatch(/volces\.com/);
    expect(LP.getProvider("deepseek").defaultEndpoint).toMatch(/deepseek\.com/);
    expect(LP.getProvider("deepseek").defaultModel).toBe("deepseek-chat");
  });

  test("getProvider returns null for unknown id", () => {
    expect(LP.getProvider("nope")).toBeNull();
  });
});

describe("Header building per provider", () => {
  test("OpenAI uses Bearer token", () => {
    const h = LP.getProvider("openai").buildHeaders("sk-test");
    expect(h.Authorization).toBe("Bearer sk-test");
    expect(h["Content-Type"]).toBe("application/json");
  });

  test("Anthropic uses x-api-key + version header", () => {
    const h = LP.getProvider("anthropic").buildHeaders("sk-ant");
    expect(h["x-api-key"]).toBe("sk-ant");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h.Authorization).toBeUndefined();
  });

  test("Doubao uses Bearer (OpenAI-compatible)", () => {
    const h = LP.getProvider("doubao").buildHeaders("DOUBAO_KEY");
    expect(h.Authorization).toBe("Bearer DOUBAO_KEY");
  });

  test("DeepSeek uses Bearer (OpenAI-compatible)", () => {
    const h = LP.getProvider("deepseek").buildHeaders("sk-deepseek");
    expect(h.Authorization).toBe("Bearer sk-deepseek");
    expect(h["Content-Type"]).toBe("application/json");
  });

  test("DeepSeek test body uses default model when none provided", () => {
    const provider = LP.getProvider("deepseek");
    const body = provider.buildTestBody("");
    expect(body.model).toBe("deepseek-chat");
    expect(body.max_tokens).toBe(1);
    expect(body.messages[0].content).toBe("ping");
  });
});

describe("Test request body shape", () => {
  test("OpenAI body has model/messages/max_tokens", () => {
    const b = LP.getProvider("openai").buildTestBody();
    expect(b.model).toBe("gpt-4o-mini");
    expect(b.messages[0]).toEqual({ role: "user", content: "ping" });
    expect(b.max_tokens).toBe(1);
  });

  test("Anthropic body shape (max_tokens at top level)", () => {
    const b = LP.getProvider("anthropic").buildTestBody();
    expect(b.max_tokens).toBe(1);
    expect(b.messages[0]).toEqual({ role: "user", content: "ping" });
  });

  test("custom model override is honored", () => {
    const b = LP.getProvider("openai").buildTestBody("gpt-4o");
    expect(b.model).toBe("gpt-4o");
  });
});

describe("Key obfuscation (base64, NOT encryption)", () => {
  test("encode → decode roundtrip preserves the key", () => {
    const key = "sk-test-abcdef-0123456789";
    expect(LP.decodeKey(LP.encodeKey(key))).toBe(key);
  });

  test("handles UTF-8 keys (e.g. CJK in custom labels)", () => {
    const key = "测试-key-🔑";
    expect(LP.decodeKey(LP.encodeKey(key))).toBe(key);
  });

  test("encodes empty / non-string to empty string", () => {
    expect(LP.encodeKey("")).toBe("");
    expect(LP.encodeKey(undefined)).toBe("");
    expect(LP.encodeKey(null)).toBe("");
    expect(LP.encodeKey(123)).toBe("");
  });

  test("decodes empty / invalid to empty string (never throws)", () => {
    expect(LP.decodeKey("")).toBe("");
    expect(LP.decodeKey(null)).toBe("");
    expect(LP.decodeKey("$$$not_base64$$$")).toBe("");
  });

  test("encoded key does not equal the plaintext", () => {
    const key = "sk-test-abcdef";
    expect(LP.encodeKey(key)).not.toBe(key);
  });
});

describe("defaultSettings", () => {
  test("returns a fresh copy each call (no shared mutation)", () => {
    const a = LP.defaultSettings();
    const b = LP.defaultSettings();
    a.enabled = true;
    expect(b.enabled).toBe(false);
  });

  test("default is disabled with provider=openai", () => {
    const s = LP.defaultSettings();
    expect(s.enabled).toBe(false);
    expect(s.provider).toBe("openai");
    expect(s.apiKey).toBe("");
  });
});

describe("validateSettings", () => {
  test("default settings are missing the api key", () => {
    expect(LP.validateSettings(LP.defaultSettings())).toContain("missing-api-key");
  });

  test("OpenAI with key + default endpoint validates", () => {
    const s = LP.defaultSettings();
    s.apiKey = LP.encodeKey("sk-test");
    expect(LP.validateSettings(s)).toEqual([]);
  });

  test("Doubao requires an explicit model (no default)", () => {
    const s = LP.defaultSettings();
    s.provider = "doubao";
    s.apiKey = LP.encodeKey("DK");
    expect(LP.validateSettings(s)).toContain("missing-model");
    s.model = "ep-2025-test";
    expect(LP.validateSettings(s)).not.toContain("missing-model");
  });

  test("custom requires both endpoint and model", () => {
    const s = LP.defaultSettings();
    s.provider = "custom";
    s.apiKey = LP.encodeKey("K");
    const reasons = LP.validateSettings(s);
    expect(reasons).toContain("missing-endpoint");
    expect(reasons).toContain("missing-model");
  });

  test("flags unknown provider", () => {
    expect(LP.validateSettings({ provider: "wat", apiKey: "x" })).toContain("unknown-provider");
  });

  test("returns missing-settings on null / non-object", () => {
    expect(LP.validateSettings(null)).toContain("missing-settings");
    expect(LP.validateSettings("string")).toContain("missing-settings");
  });
});

describe("buildTestRequest", () => {
  test("OpenAI: combines endpoint + headers + body", () => {
    const s = LP.defaultSettings();
    s.apiKey = LP.encodeKey("sk-test");
    const req = LP.buildTestRequest(s);
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(req.body).messages[0].content).toBe("ping");
  });

  test("custom endpoint override is honored", () => {
    const s = LP.defaultSettings();
    s.apiKey = LP.encodeKey("sk-test");
    s.endpoint = "https://my-proxy.example.com/v1/chat/completions";
    expect(LP.buildTestRequest(s).url).toBe(
      "https://my-proxy.example.com/v1/chat/completions"
    );
  });

  test("throws on unknown provider", () => {
    expect(() => LP.buildTestRequest({ provider: "nope" })).toThrow(/unknown provider/);
  });

  test("throws when endpoint is missing (custom without override)", () => {
    const s = { provider: "custom", apiKey: LP.encodeKey("k"), model: "m" };
    expect(() => LP.buildTestRequest(s)).toThrow(/no endpoint/);
  });

  test("throws when api key is missing", () => {
    const s = LP.defaultSettings();
    expect(() => LP.buildTestRequest(s)).toThrow(/no api key/);
  });
});
