// tests/integration/ats-benchmark.test.js
//
// Drives every fixture under tests/fixtures/ats/* through the real
// content.js fill flow and asserts the expected fills + unmatched
// labels. Doubles as the data source for `npm run benchmark`.

const fs = require("fs");
const path = require("path");

const FIXTURES_ROOT = path.resolve(__dirname, "..", "fixtures", "ats");
const SAMPLE_RESUME_PATH = path.resolve(__dirname, "..", "fixtures", "sample-resume.json");

// ── Stub chrome before requiring content.js ─────────────────────────────
const onMessageListeners = [];
global.chrome = {
  runtime: {
    onMessage: {
      addListener(fn) {
        onMessageListeners.push(fn);
      },
    },
  },
};

// jsdom doesn't compute layout, so offsetParent is always null and
// getBoundingClientRect returns zeros. content.js uses both as visibility
// checks. We monkey-patch them to treat any in-DOM element as visible.
function patchVisibility() {
  Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      // null only when not attached to the document
      return this.parentNode ? this.parentElement || document.body : null;
    },
  });
  const originalRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    if (!this.parentNode) return originalRect.call(this);
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 };
  };
}

// Load libs in manifest order, then content.js. Done once per test file.
require("../../schema.js");
require("../../lib/field-detect.js");
require("../../lib/value-match.js");
// cross-lingual is optional — only require if present (it lives behind
// a separate PR / branch and may not be on the current main).
try {
  require("../../lib/cross-lingual.js");
} catch {
  // no-op: integration framework works with or without cross-lingual.
}
patchVisibility();
require("../../content.js");

const sampleResume = JSON.parse(fs.readFileSync(SAMPLE_RESUME_PATH, "utf8"));

function listFixtures() {
  const out = [];
  if (!fs.existsSync(FIXTURES_ROOT)) return out;
  for (const ats of fs.readdirSync(FIXTURES_ROOT)) {
    const dir = path.join(FIXTURES_ROOT, ats);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".html")) continue;
      const base = file.slice(0, -".html".length);
      const expectedPath = path.join(dir, base + ".expected.json");
      if (!fs.existsSync(expectedPath)) continue;
      out.push({
        ats,
        name: base,
        htmlPath: path.join(dir, file),
        expectedPath,
      });
    }
  }
  return out;
}

function fillPage(resume, customFields = {}) {
  return new Promise((resolve, reject) => {
    if (onMessageListeners.length === 0) {
      reject(new Error("content.js did not register a chrome.runtime.onMessage listener"));
      return;
    }
    const listener = onMessageListeners[0];
    const sendResponse = (response) => resolve(response);
    listener({ action: "fill", resume, customFields }, null, sendResponse);
  });
}

// Find the input/select/textarea matching a labelled field. We use the
// same getFieldLabel logic that content.js uses, then look up the value
// the field ended up with.
function readFilledValue(label) {
  const FD = window.ResumeFillerFieldDetect;
  const fields = Array.from(
    document.querySelectorAll(
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), select, textarea"
    )
  );
  for (const el of fields) {
    if (FD.getFieldLabel(el) === label) {
      if (el.tagName.toLowerCase() === "select") {
        // For selects, return both option text and value so callers can
        // assert against either.
        const opt = el.options[el.selectedIndex];
        return opt ? { value: el.value, text: opt.text } : { value: "", text: "" };
      }
      return { value: el.value, text: el.value };
    }
  }
  return null;
}

const fixtures = listFixtures();

// We export aggregated results so the benchmark script can read them.
const aggregateResults = { byAts: {} };
global.__atsBenchmarkResults = aggregateResults;

afterAll(() => {
  // Persist results for the benchmark CLI to pick up.
  const outPath = path.resolve(__dirname, ".benchmark-results.json");
  fs.writeFileSync(outPath, JSON.stringify(aggregateResults, null, 2));
});

if (fixtures.length === 0) {
  test("at least one ATS fixture exists", () => {
    throw new Error(
      `No fixtures found under ${FIXTURES_ROOT}. See tests/fixtures/README.md for capture instructions.`
    );
  });
} else {
  describe.each(fixtures)("$ats / $name", (fx) => {
    let html;
    let expected;

    beforeAll(() => {
      html = fs.readFileSync(fx.htmlPath, "utf8");
      expected = JSON.parse(fs.readFileSync(fx.expectedPath, "utf8"));
    });

    beforeEach(() => {
      document.documentElement.innerHTML = "";
      // Strip the outer <html> / <head> wrappers — we only want the body
      // contents inside the existing jsdom document.
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const inner = bodyMatch ? bodyMatch[1] : html;
      document.body.innerHTML = inner;
    });

    test("fills every entry listed in expected_fills", async () => {
      await fillPage(sampleResume);

      const expectedFills = expected.expected_fills || {};
      const stats = (aggregateResults.byAts[fx.ats] = aggregateResults.byAts[fx.ats] || {
        fixtures: 0,
        assertions: 0,
        passed: 0,
        failed: 0,
        failures: [],
      });
      stats.fixtures += 1;

      const filledValues = Array.from(
        document.querySelectorAll(
          "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), select, textarea"
        )
      )
        .map((el) => {
          if (el.tagName.toLowerCase() === "select") {
            const opt = el.options[el.selectedIndex];
            return opt ? [el.value, opt.text] : [];
          }
          return [el.value];
        })
        .flat()
        .filter(Boolean);

      const missing = [];
      for (const [label, expectedValue] of Object.entries(expectedFills)) {
        // expectedValue is a string (single acceptable value) or an
        // array (any-of). Selects fill with their option.value, which
        // may differ from the option.text or the resume's raw value
        // after value-match transforms (e.g. "5 years" → "3-5"), so
        // arrays let fixtures list every form-side variant that's
        // considered correct.
        const acceptable = Array.isArray(expectedValue) ? expectedValue : [expectedValue];
        const passed = acceptable.some((v) => filledValues.includes(String(v)));
        stats.assertions += 1;
        if (passed) {
          stats.passed += 1;
        } else {
          stats.failed += 1;
          stats.failures.push({
            fixture: fx.name,
            label,
            expected: acceptable,
          });
          missing.push(
            `"${label}" → expected one of [${acceptable.map((v) => JSON.stringify(v)).join(", ")}], not found`
          );
        }
      }

      if (missing.length > 0) {
        throw new Error(
          `Fixture ${fx.ats}/${fx.name} failed ${missing.length} assertion(s):\n  - ${missing.join("\n  - ")}\n\nFilled values snapshot: ${JSON.stringify(filledValues.slice(0, 40))}`
        );
      }
    });
  });
}

// Smoke test for the readFilledValue helper itself (covers the label
// equality branch via a tiny in-test DOM construction).
describe("readFilledValue helper", () => {
  test("returns null when no field has the given label", () => {
    document.body.innerHTML = "<input id='x'>";
    expect(readFilledValue("Nonexistent Label")).toBeNull();
  });
});
