// lib/llm-match.js — LLM batch fallback matcher for unmatched fields
//
// Called by content.js's handleFill when the user invokes "AI takeover"
// (the trigger button arrives in #10). Takes the unmatched-field labels
// + the resume's flat key-value map, asks the configured LLM to fill in
// what the rule engine couldn't, returns { label: value }.
//
// Caches results by (domain, sorted label set) for 7 days to avoid
// re-paying for the same site on a repeat visit. Tracks per-month call
// counts in chrome.storage.local.aiStats.
//
// Loaded after lib/llm-providers.js. Exposes window.ResumeFillerLLMMatch.

(function (global) {
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CACHE_PREFIX = "aiCache::";
  const STATS_KEY = "aiStats";
  const STORAGE = () => global.chrome?.storage?.local || null;

  function hashLabels(labels) {
    return labels.slice().sort().join("||");
  }

  function cacheKey(domain, labels) {
    return CACHE_PREFIX + (domain || "_") + "::" + hashLabels(labels);
  }

  function getCache(domain, labels) {
    const storage = STORAGE();
    if (!storage) return Promise.resolve(null);
    const key = cacheKey(domain, labels);
    return new Promise((resolve) => {
      storage.get(key, (res) => {
        const entry = res && res[key];
        if (entry && entry.ts && Date.now() - entry.ts < CACHE_TTL_MS) {
          resolve(entry.values);
        } else {
          resolve(null);
        }
      });
    });
  }

  function setCache(domain, labels, values) {
    const storage = STORAGE();
    if (!storage) return Promise.resolve();
    const key = cacheKey(domain, labels);
    return new Promise((resolve) => {
      storage.set({ [key]: { ts: Date.now(), values } }, () => resolve());
    });
  }

  function bumpStats(callCount = 1) {
    const storage = STORAGE();
    if (!storage) return Promise.resolve();
    return new Promise((resolve) => {
      storage.get(STATS_KEY, (res) => {
        const stats = (res && res[STATS_KEY]) || { monthly: {} };
        const month = new Date().toISOString().slice(0, 7);
        stats.monthly[month] = stats.monthly[month] || { calls: 0 };
        stats.monthly[month].calls += callCount;
        storage.set({ [STATS_KEY]: stats }, () => resolve());
      });
    });
  }

  function buildPrompt(labels, resumeFlat) {
    const resumePretty = JSON.stringify(resumeFlat, null, 2);
    const labelsPretty = JSON.stringify(labels);
    return [
      "You are an expert resume autofill assistant. A job application form has the following unmatched field labels that the rule-based matcher could not handle.",
      "",
      "Resume (JSON, the source of truth — do not invent values that aren't here):",
      resumePretty,
      "",
      "Unmatched form labels:",
      labelsPretty,
      "",
      "For each label, choose the most likely value from the resume above. If no good candidate exists, use an empty string.",
      "",
      "Reply with a SINGLE JSON object mapping each label exactly as given to a string value. No prose, no markdown fences. Example:",
      '{"Language Proficiency": "Fluent", "Years of Experience": "5"}',
    ].join("\n");
  }

  function buildChatBody(provider, model, prompt) {
    if (provider.id === "anthropic") {
      return {
        model: model || provider.defaultModel,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      };
    }
    return {
      model: model || provider.defaultModel,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      temperature: 0,
    };
  }

  function extractText(body) {
    if (body && body.choices && body.choices[0] && body.choices[0].message) {
      return body.choices[0].message.content || "";
    }
    if (body && body.content && body.content[0] && body.content[0].text) {
      return body.content[0].text || "";
    }
    return "";
  }

  function parseLLMResponse(body) {
    const raw = extractText(body);
    if (!raw) return {};
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch {
          return {};
        }
      }
      return {};
    }
  }

  // matchFields: pure call to the LLM, no cache, no stats.
  // deps: { fetch, providers } — for tests to inject mocks.
  async function matchFields(labels, resumeFlat, settings, deps) {
    deps = deps || {};
    const fetchFn = deps.fetch || (typeof fetch !== "undefined" ? fetch : null);
    const LP = deps.providers || global.ResumeFillerLLMProviders;
    if (!fetchFn || !LP) return {};
    if (!Array.isArray(labels) || labels.length === 0) return {};
    if (!settings || !settings.enabled) return {};

    const provider = LP.getProvider(settings.provider);
    if (!provider) return {};
    const url = (settings.endpoint || provider.defaultEndpoint || "").trim();
    const apiKey = LP.decodeKey(settings.apiKey || "");
    if (!url || !apiKey) return {};

    const prompt = buildPrompt(labels, resumeFlat || {});
    const body = buildChatBody(provider, settings.model, prompt);

    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: provider.buildHeaders(apiKey),
        body: JSON.stringify(body),
      });
      if (!res || !res.ok) return {};
      const json = await res.json();
      return parseLLMResponse(json);
    } catch {
      return {};
    }
  }

  // matchWithCache: cache check → matchFields → cache set + stats bump.
  // Failures (no provider, no key, network error, malformed response)
  // resolve to {} and never throw, so callers can always continue with
  // the rule-based fill flow.
  async function matchWithCache(domain, labels, resumeFlat, settings, deps) {
    if (!Array.isArray(labels) || labels.length === 0) return {};
    const cached = await getCache(domain, labels);
    if (cached) return cached;
    const values = await matchFields(labels, resumeFlat, settings, deps);
    if (values && Object.keys(values).length > 0) {
      await setCache(domain, labels, values);
      await bumpStats(1);
    }
    return values || {};
  }

  global.ResumeFillerLLMMatch = {
    matchFields,
    matchWithCache,
    getCache,
    setCache,
    bumpStats,
    parseLLMResponse,
    buildPrompt,
    buildChatBody,
    hashLabels,
    cacheKey,
    CACHE_TTL_MS,
    CACHE_PREFIX,
    STATS_KEY,
  };
})(typeof window !== "undefined" ? window : globalThis);
