require("../lib/llm-providers.js");
require("../lib/llm-match.js");

const LP = window.ResumeFillerLLMProviders;
const LM = window.ResumeFillerLLMMatch;

// In-memory chrome.storage.local stub. Each test starts fresh.
function makeStorageStub() {
  const data = {};
  return {
    data,
    api: {
      get(keyOrKeys, cb) {
        const out = {};
        const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
        keys.forEach((k) => {
          if (k in data) out[k] = data[k];
        });
        cb(out);
      },
      set(obj, cb) {
        Object.assign(data, obj);
        if (cb) cb();
      },
      remove(key, cb) {
        delete data[key];
        if (cb) cb();
      },
    },
  };
}

beforeEach(() => {
  const stub = makeStorageStub();
  global.chrome = { storage: { local: stub.api } };
  global.__storage = stub;
});

afterEach(() => {
  delete global.chrome;
  delete global.__storage;
});

function settingsWithKey(overrides) {
  const base = LP.defaultSettings();
  base.enabled = true;
  base.apiKey = LP.encodeKey("sk-test-key");
  return { ...base, ...overrides };
}

describe("hashLabels / cacheKey", () => {
  test("hashLabels is order-insensitive", () => {
    expect(LM.hashLabels(["a", "b", "c"])).toBe(LM.hashLabels(["c", "b", "a"]));
  });

  test("cacheKey embeds domain and label hash", () => {
    expect(LM.cacheKey("greenhouse.io", ["A", "B"])).toContain("greenhouse.io");
    expect(LM.cacheKey("greenhouse.io", ["A", "B"])).toContain("A||B");
  });
});

describe("buildPrompt", () => {
  test("includes resume JSON and labels", () => {
    const p = LM.buildPrompt(["Visa Sponsorship?"], { name: "Alice", email: "a@b.com" });
    expect(p).toContain("Visa Sponsorship?");
    expect(p).toContain('"name": "Alice"');
    expect(p).toMatch(/SINGLE JSON object/);
  });
});

describe("buildChatBody", () => {
  test("OpenAI body sets temperature 0 and max_tokens", () => {
    const provider = LP.getProvider("openai");
    const b = LM.buildChatBody(provider, "", "hello");
    expect(b.model).toBe("gpt-4o-mini");
    expect(b.temperature).toBe(0);
    expect(b.max_tokens).toBe(1024);
  });

  test("Anthropic body has top-level max_tokens (no temperature)", () => {
    const provider = LP.getProvider("anthropic");
    const b = LM.buildChatBody(provider, "", "hello");
    expect(b.max_tokens).toBe(1024);
    expect(b.temperature).toBeUndefined();
  });

  test("explicit model overrides default", () => {
    const provider = LP.getProvider("openai");
    expect(LM.buildChatBody(provider, "gpt-4o", "hi").model).toBe("gpt-4o");
  });
});

describe("parseLLMResponse", () => {
  test("extracts JSON from OpenAI choices[0].message.content", () => {
    expect(
      LM.parseLLMResponse({
        choices: [{ message: { content: '{"Visa": "Yes"}' } }],
      })
    ).toEqual({ Visa: "Yes" });
  });

  test("extracts JSON from Anthropic content[0].text", () => {
    expect(
      LM.parseLLMResponse({
        content: [{ text: '{"Years": "5"}' }],
      })
    ).toEqual({ Years: "5" });
  });

  test("strips markdown code fences", () => {
    expect(
      LM.parseLLMResponse({
        choices: [{ message: { content: '```json\n{"a": "b"}\n```' } }],
      })
    ).toEqual({ a: "b" });
  });

  test("recovers JSON object embedded in surrounding prose", () => {
    expect(
      LM.parseLLMResponse({
        choices: [{ message: { content: 'Here is the answer: {"a": "b"} hope this helps' } }],
      })
    ).toEqual({ a: "b" });
  });

  test("returns {} on malformed response", () => {
    expect(LM.parseLLMResponse({ choices: [{ message: { content: "not json at all" } }] })).toEqual({});
    expect(LM.parseLLMResponse({})).toEqual({});
    expect(LM.parseLLMResponse(null)).toEqual({});
  });

  test("rejects array responses (must be an object)", () => {
    expect(
      LM.parseLLMResponse({
        choices: [{ message: { content: '["a", "b"]' } }],
      })
    ).toEqual({});
  });
});

describe("matchFields — happy path", () => {
  test("calls fetch with provider URL/headers/body and returns parsed values", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"Visa": "Yes"}' } }] }),
    });
    const result = await LM.matchFields(
      ["Visa Sponsorship?"],
      { email: "a@b.com" },
      settingsWithKey(),
      { fetch: fetchMock }
    );
    expect(result).toEqual({ Visa: "Yes" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(opts.headers.Authorization).toBe("Bearer sk-test-key");
    const body = JSON.parse(opts.body);
    expect(body.messages[0].content).toContain("Visa Sponsorship?");
  });
});

describe("matchFields — guard clauses", () => {
  test("returns {} when settings disabled", async () => {
    const fetchMock = jest.fn();
    const s = settingsWithKey();
    s.enabled = false;
    const result = await LM.matchFields(["X"], {}, s, { fetch: fetchMock });
    expect(result).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns {} when no labels", async () => {
    const fetchMock = jest.fn();
    expect(await LM.matchFields([], {}, settingsWithKey(), { fetch: fetchMock })).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns {} when API key missing", async () => {
    const fetchMock = jest.fn();
    const s = settingsWithKey();
    s.apiKey = "";
    expect(await LM.matchFields(["X"], {}, s, { fetch: fetchMock })).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns {} on non-ok HTTP response", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await LM.matchFields(["X"], {}, settingsWithKey(), { fetch: fetchMock })).toEqual({});
  });

  test("returns {} on network error (never throws)", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("offline"));
    await expect(
      LM.matchFields(["X"], {}, settingsWithKey(), { fetch: fetchMock })
    ).resolves.toEqual({});
  });
});

describe("getCache / setCache", () => {
  test("setCache then getCache roundtrips", async () => {
    await LM.setCache("greenhouse.io", ["A", "B"], { A: "1", B: "2" });
    const got = await LM.getCache("greenhouse.io", ["A", "B"]);
    expect(got).toEqual({ A: "1", B: "2" });
  });

  test("getCache is order-insensitive over labels", async () => {
    await LM.setCache("d", ["x", "y"], { x: "1", y: "2" });
    expect(await LM.getCache("d", ["y", "x"])).toEqual({ x: "1", y: "2" });
  });

  test("getCache returns null past TTL", async () => {
    await LM.setCache("d", ["a"], { a: "1" });
    // Manually age the entry beyond TTL.
    const stub = global.__storage.data;
    const key = LM.cacheKey("d", ["a"]);
    stub[key].ts = Date.now() - LM.CACHE_TTL_MS - 1;
    expect(await LM.getCache("d", ["a"])).toBeNull();
  });

  test("getCache returns null when no chrome.storage", async () => {
    delete global.chrome;
    expect(await LM.getCache("d", ["a"])).toBeNull();
  });
});

describe("bumpStats", () => {
  test("creates monthly bucket and increments", async () => {
    await LM.bumpStats(1);
    await LM.bumpStats(2);
    const month = new Date().toISOString().slice(0, 7);
    expect(global.__storage.data.aiStats.monthly[month].calls).toBe(3);
  });

  test("no-op when chrome.storage is unavailable", async () => {
    delete global.chrome;
    await expect(LM.bumpStats(1)).resolves.toBeUndefined();
  });
});

describe("matchWithCache", () => {
  test("cache hit avoids the network call and stats bump", async () => {
    const fetchMock = jest.fn();
    await LM.setCache("g.io", ["A"], { A: "1" });
    const result = await LM.matchWithCache("g.io", ["A"], {}, settingsWithKey(), {
      fetch: fetchMock,
    });
    expect(result).toEqual({ A: "1" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(global.__storage.data.aiStats).toBeUndefined();
  });

  test("cache miss → fetch → cache → stats bump", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"A": "1"}' } }] }),
    });
    const result = await LM.matchWithCache("g.io", ["A"], {}, settingsWithKey(), {
      fetch: fetchMock,
    });
    expect(result).toEqual({ A: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cached now
    expect(await LM.getCache("g.io", ["A"])).toEqual({ A: "1" });

    // Stats bumped
    const month = new Date().toISOString().slice(0, 7);
    expect(global.__storage.data.aiStats.monthly[month].calls).toBe(1);

    // Second call hits cache, no second fetch
    const second = await LM.matchWithCache("g.io", ["A"], {}, settingsWithKey(), {
      fetch: fetchMock,
    });
    expect(second).toEqual({ A: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(global.__storage.data.aiStats.monthly[month].calls).toBe(1);
  });

  test("empty result is not cached and does not bump stats", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "garbage" } }] }),
    });
    const result = await LM.matchWithCache("g.io", ["A"], {}, settingsWithKey(), {
      fetch: fetchMock,
    });
    expect(result).toEqual({});
    expect(global.__storage.data.aiStats).toBeUndefined();
    expect(await LM.getCache("g.io", ["A"])).toBeNull();
  });

  test("returns {} for empty labels without touching network or cache", async () => {
    const fetchMock = jest.fn();
    expect(await LM.matchWithCache("g.io", [], {}, settingsWithKey(), { fetch: fetchMock })).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
