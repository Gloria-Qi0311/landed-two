// lib/llm-providers.js — LLM provider configs + key obfuscation
//
// Used by the options page's "AI settings" section (#8) and by the
// LLM matcher (#9). Pure JS; no DOM or chrome.* deps so it's
// testable directly.
//
// Loaded as a script in options.html and (later, by #9) in the
// content_scripts list. Exposes window.ResumeFillerLLMProviders.

(function (global) {
  // Each provider description supplies:
  //   id              — stable storage key
  //   name            — display label
  //   defaultEndpoint — the chat-completion URL (user can override)
  //   defaultModel    — a low-cost model good enough for the test ping
  //   buildHeaders(key) — request headers
  //   buildTestBody(model) — minimal body that the "test key" button
  //                          posts to verify the key works
  const PROVIDERS = {
    openai: {
      id: "openai",
      name: "OpenAI",
      defaultEndpoint: "https://api.openai.com/v1/chat/completions",
      defaultModel: "gpt-4o-mini",
      buildHeaders(key) {
        return {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        };
      },
      buildTestBody(model) {
        return {
          model: model || this.defaultModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        };
      },
    },
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      defaultEndpoint: "https://api.anthropic.com/v1/messages",
      defaultModel: "claude-haiku-4-5",
      buildHeaders(key) {
        return {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        };
      },
      buildTestBody(model) {
        return {
          model: model || this.defaultModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        };
      },
    },
    doubao: {
      id: "doubao",
      name: "Doubao (豆包 / 火山方舟)",
      defaultEndpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      // Doubao requires a user-specific endpoint id rather than a public
      // model name; leave default empty so the user must paste theirs.
      defaultModel: "",
      buildHeaders(key) {
        return {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        };
      },
      buildTestBody(model) {
        return {
          model: model || this.defaultModel,
          messages: [{ role: "user", content: "ping" }],
        };
      },
    },
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      // OpenAI-compatible API. DeepSeek accepts both /v1/chat/completions
      // and /chat/completions; the /v1 form mirrors OpenAI's path so
      // users porting an existing OpenAI SDK config have less to change.
      defaultEndpoint: "https://api.deepseek.com/v1/chat/completions",
      defaultModel: "deepseek-chat",
      buildHeaders(key) {
        return {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        };
      },
      buildTestBody(model) {
        return {
          model: model || this.defaultModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        };
      },
    },
    custom: {
      id: "custom",
      name: "Custom (OpenAI-compatible)",
      defaultEndpoint: "",
      defaultModel: "",
      buildHeaders(key) {
        return {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        };
      },
      buildTestBody(model) {
        return {
          model: model || "",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        };
      },
    },
  };

  function listProviders() {
    return Object.keys(PROVIDERS).map((id) => ({
      id,
      name: PROVIDERS[id].name,
    }));
  }

  function getProvider(id) {
    return PROVIDERS[id] || null;
  }

  // ── Key obfuscation ────────────────────────────────────────────────────
  // chrome.storage.local is plaintext — anyone who can inspect the
  // extension's storage can see what's there. Base64 only protects against
  // casual log-skimming and screen-shoulder-surfing. Surface this clearly
  // in the UI; do NOT call it encryption.
  function encodeKey(plain) {
    if (typeof plain !== "string" || plain.length === 0) return "";
    return btoa(unescape(encodeURIComponent(plain)));
  }

  function decodeKey(encoded) {
    if (typeof encoded !== "string" || encoded.length === 0) return "";
    try {
      return decodeURIComponent(escape(atob(encoded)));
    } catch {
      return "";
    }
  }

  // ── Settings storage shape ─────────────────────────────────────────────
  //   chrome.storage.local.aiSettings = {
  //     enabled: boolean,
  //     provider: 'openai' | 'anthropic' | 'doubao' | 'deepseek' | 'custom',
  //     endpoint: string,    // optional override
  //     model: string,       // optional override
  //     apiKey: string,      // base64-encoded
  //   }
  const DEFAULT_SETTINGS = {
    enabled: false,
    provider: "openai",
    endpoint: "",
    model: "",
    apiKey: "",
  };

  function defaultSettings() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  // Validates a settings object; returns the missing reasons.
  // Empty array = ready to use.
  function validateSettings(settings) {
    const reasons = [];
    if (!settings || typeof settings !== "object") {
      return ["missing-settings"];
    }
    const provider = getProvider(settings.provider);
    if (!provider) reasons.push("unknown-provider");
    const endpoint = (settings.endpoint || provider?.defaultEndpoint || "").trim();
    if (!endpoint) reasons.push("missing-endpoint");
    if (!settings.apiKey) reasons.push("missing-api-key");
    if (provider && !provider.defaultModel) {
      const model = (settings.model || "").trim();
      if (!model) reasons.push("missing-model");
    }
    return reasons;
  }

  // Resolves the request shape for the test button. Caller does fetch().
  function buildTestRequest(settings) {
    const provider = getProvider(settings.provider);
    if (!provider) throw new Error("unknown provider: " + settings.provider);
    const url = (settings.endpoint || provider.defaultEndpoint || "").trim();
    if (!url) throw new Error("no endpoint configured");
    const apiKey = decodeKey(settings.apiKey);
    if (!apiKey) throw new Error("no api key");
    return {
      url,
      method: "POST",
      headers: provider.buildHeaders(apiKey),
      body: JSON.stringify(provider.buildTestBody(settings.model)),
    };
  }

  global.ResumeFillerLLMProviders = {
    listProviders,
    getProvider,
    encodeKey,
    decodeKey,
    defaultSettings,
    validateSettings,
    buildTestRequest,
    DEFAULT_SETTINGS,
  };
})(typeof window !== "undefined" ? window : globalThis);
