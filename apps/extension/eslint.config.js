const js = require("@eslint/js");
const noUnsanitized = require("eslint-plugin-no-unsanitized");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "assets/**",
      "icons/**",
      "**/*.min.js"
    ]
  },
  js.configs.recommended,
  noUnsanitized.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly"
      }
    }
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node
      }
    },
    // Test fixtures intentionally set innerHTML from string literals; the
    // value is never user-controlled, so the security rule is noise here.
    rules: {
      "no-unsanitized/property": "off",
      "no-unsanitized/method": "off"
    }
  },
  {
    files: ["eslint.config.js", "jest.config.*", "scripts/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node }
    }
  }
];
