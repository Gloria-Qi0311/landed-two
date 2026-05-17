#!/usr/bin/env node
// scripts/benchmark.js — runs the integration test suite and prints a
// per-ATS accuracy table. Read by humans (npm run benchmark) and by
// future store-listing copy.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const RESULTS_PATH = path.resolve(
  __dirname,
  "..",
  "tests",
  "integration",
  ".benchmark-results.json"
);

if (fs.existsSync(RESULTS_PATH)) fs.unlinkSync(RESULTS_PATH);

let testsExitCode = 0;
try {
  // Run the integration test file specifically. We want it to populate
  // .benchmark-results.json regardless of pass/fail so the table still
  // prints on a regression.
  execSync("npx jest tests/integration --silent", { stdio: "inherit" });
} catch (err) {
  testsExitCode = err.status || 1;
}

if (!fs.existsSync(RESULTS_PATH)) {
  console.error(
    "\nNo benchmark results were produced. The integration suite may not have run."
  );
  process.exit(testsExitCode || 1);
}

const results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
const rows = Object.entries(results.byAts || {})
  .map(([ats, s]) => ({
    ats,
    fixtures: s.fixtures,
    assertions: s.assertions,
    passed: s.passed,
    failed: s.failed,
    accuracy: s.assertions === 0 ? 0 : s.passed / s.assertions,
  }))
  .sort((a, b) => a.ats.localeCompare(b.ats));

const total = rows.reduce(
  (acc, r) => ({
    fixtures: acc.fixtures + r.fixtures,
    assertions: acc.assertions + r.assertions,
    passed: acc.passed + r.passed,
    failed: acc.failed + r.failed,
  }),
  { fixtures: 0, assertions: 0, passed: 0, failed: 0 }
);

const totalRow = {
  ats: "TOTAL",
  fixtures: total.fixtures,
  assertions: total.assertions,
  passed: total.passed,
  failed: total.failed,
  accuracy: total.assertions === 0 ? 0 : total.passed / total.assertions,
};

const colWidths = {
  ats: Math.max(12, ...rows.map((r) => r.ats.length), totalRow.ats.length),
  fixtures: 8,
  assertions: 10,
  passed: 6,
  failed: 6,
  accuracy: 10,
};

function pad(s, w, right = false) {
  s = String(s);
  return right ? s.padStart(w) : s.padEnd(w);
}

function fmtAccuracy(a) {
  return `${(a * 100).toFixed(1)}%`;
}

console.log("\n=== ATS fixture benchmark ===\n");
console.log(
  pad("ATS", colWidths.ats) +
    "  " +
    pad("Fixtures", colWidths.fixtures, true) +
    "  " +
    pad("Asserts", colWidths.assertions, true) +
    "  " +
    pad("Pass", colWidths.passed, true) +
    "  " +
    pad("Fail", colWidths.failed, true) +
    "  " +
    pad("Accuracy", colWidths.accuracy, true)
);
console.log("-".repeat(colWidths.ats + 2 + colWidths.fixtures + 2 + colWidths.assertions + 2 + colWidths.passed + 2 + colWidths.failed + 2 + colWidths.accuracy));

for (const r of rows) {
  console.log(
    pad(r.ats, colWidths.ats) +
      "  " +
      pad(r.fixtures, colWidths.fixtures, true) +
      "  " +
      pad(r.assertions, colWidths.assertions, true) +
      "  " +
      pad(r.passed, colWidths.passed, true) +
      "  " +
      pad(r.failed, colWidths.failed, true) +
      "  " +
      pad(fmtAccuracy(r.accuracy), colWidths.accuracy, true)
  );
}

console.log("-".repeat(colWidths.ats + 2 + colWidths.fixtures + 2 + colWidths.assertions + 2 + colWidths.passed + 2 + colWidths.failed + 2 + colWidths.accuracy));
console.log(
  pad(totalRow.ats, colWidths.ats) +
    "  " +
    pad(totalRow.fixtures, colWidths.fixtures, true) +
    "  " +
    pad(totalRow.assertions, colWidths.assertions, true) +
    "  " +
    pad(totalRow.passed, colWidths.passed, true) +
    "  " +
    pad(totalRow.failed, colWidths.failed, true) +
    "  " +
    pad(fmtAccuracy(totalRow.accuracy), colWidths.accuracy, true)
);
console.log("");

process.exit(testsExitCode);
