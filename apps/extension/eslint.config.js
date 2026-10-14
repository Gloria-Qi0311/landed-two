const js = require("@eslint/js");
const noUnsanitized = require("eslint-plugin-no-unsanitized");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
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
        chrome: "readonly",
        importScripts: "readonly"
      },
    },
    rules: {
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: true
      }]
    }
  },
  {
    // These browser scripts also expose CommonJS exports for Jest. Keep the
    // runtime code usable through importScripts while teaching ESLint about
    // the two test-only globals instead of disabling no-undef wholesale.
    files: ["lib/**/*.js"],
    languageOptions: {
      globals: {
        module: "readonly",
        require: "readonly"
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
