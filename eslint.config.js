// ESLint Flat Config for AutoDev.
//
// Agents: Do NOT relax these rules to make a change pass. Fix the underlying
// design/code issue or add a narrowly scoped exception with an explanation.
//
// Rules and strictness follow SimulatorLife/RacingGame's configuration, adapted
// to a Node-only codebase: Node globals instead of browser ones, and
// AutoDev's own module layers in place of the game's architecture. Like
// RacingGame this is syntax-aware rather than type-checked TypeScript linting.

import pluginE18e from "@e18e/eslint-plugin";
import { fixupPluginRules } from "@eslint/compat";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import pluginBoundaries from "eslint-plugin-boundaries";
import pluginDeMorgan from "eslint-plugin-de-morgan";
import pluginEslintComments from "eslint-plugin-eslint-comments";
import pluginImport from "eslint-plugin-import-x";
import pluginNoSecrets from "eslint-plugin-no-secrets";
import pluginPromise from "eslint-plugin-promise";
import pluginRegexp from "eslint-plugin-regexp";
import pluginSecurity from "eslint-plugin-security";
import pluginSimpleImportSort from "eslint-plugin-simple-import-sort";
import pluginSonarjs from "eslint-plugin-sonarjs";
import pluginUnicorn from "eslint-plugin-unicorn";
import pluginUnusedImports from "eslint-plugin-unused-imports";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const tsImportResolver = createTypeScriptImportResolver({
  project: ["./tsconfig.json"]
});

const typeScriptPlugin = { "@typescript-eslint": tseslint.plugin };
const TEST_FILES = ["tests/**/*.ts"];

const baseIgnorePatterns = [
  "**/*.d.ts",
  "**/node_modules/**",
  "**/coverage/**",
  "**/*.md",
  ".DS_Store",
  "docs/**",
  // Generated from .rulesync/ by `rulesync generate`; the source is linted.
  ".agents/**",
  ".claude/**",
  ".github/skills/**"
];

const baseRestrictedSyntax = [
  {
    selector: "LabeledStatement",
    message: "Labels make control flow harder to follow."
  },
  {
    selector: "ForInStatement",
    message: "Use Object.keys/values/entries with for...of instead of for...in."
  }
];

const focusedTestRestrictedSyntax = [
  ...baseRestrictedSyntax,
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(only|skip)$/]",
    message: "Focused/skipped tests must not be committed."
  }
];

// One owner per source file. Mirrors the layering described in
// docs/typescript-target-state.md: shared primitives at the bottom, the
// router and the provider bridges side by side (neither imports the other),
// platform lifecycle over config, and the CLI and hooks on top.
const architectureElements = [
  { type: "shared", pattern: "src/shared/**" },
  { type: "telemetry", pattern: "src/telemetry/**" },
  { type: "agents", pattern: "src/agents/**" },
  { type: "config", pattern: "src/config/**" },
  { type: "mcp", pattern: "src/mcp/**" },
  { type: "router", pattern: "src/router/**" },
  { type: "providers", pattern: "src/providers/**" },
  { type: "platform", pattern: "src/platform/**" },
  { type: "hooks", pattern: "src/hooks/**" },
  { type: "cli", pattern: "src/cli/**" },
  { type: "skill-script", pattern: ".rulesync/skills/**" },
  { type: "test", pattern: "tests/**" }
];

const allSourceElements = [
  "shared",
  "telemetry",
  "agents",
  "config",
  "mcp",
  "router",
  "providers",
  "platform",
  "hooks",
  "cli"
];

const allowOnly = (from, to) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: [from, ...to] } } } }
});

const architecturePolicies = [
  allowOnly("shared", []),
  allowOnly("telemetry", ["shared"]),
  allowOnly("agents", ["shared"]),
  allowOnly("config", ["shared"]),
  allowOnly("mcp", ["shared"]),
  allowOnly("router", ["shared", "agents", "telemetry"]),
  allowOnly("providers", ["shared", "agents", "telemetry"]),
  allowOnly("platform", ["shared", "config"]),
  allowOnly("hooks", ["shared", "agents", "telemetry", "platform"]),
  allowOnly("cli", ["shared", "config", "platform", "router"]),
  // Skill scripts ship inside a skill folder and run standalone.
  allowOnly("skill-script", []),
  allowOnly("test", [...allSourceElements, "skill-script"])
];

const tsConfig = defineConfig({
  files: ["**/*.ts"],
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: "module",
    globals: globals.node,
    parser: tseslint.parser
  },
  extends: [
    js.configs.recommended,
    pluginDeMorgan.configs.recommended,
    pluginUnicorn.configs.recommended,
    pluginPromise.configs["flat/recommended"],
    ...tseslint.configs.recommended
  ],
  linterOptions: { reportUnusedDisableDirectives: true },
  plugins: {
    ...typeScriptPlugin,
    e18e: pluginE18e,
    sonarjs: pluginSonarjs,
    security: pluginSecurity,
    import: pluginImport,
    regexp: pluginRegexp,
    "no-secrets": pluginNoSecrets,
    "eslint-comments": fixupPluginRules(pluginEslintComments),
    "unused-imports": pluginUnusedImports,
    "simple-import-sort": pluginSimpleImportSort
  },
  settings: {
    "import-x/extensions": [".js", ".ts"],
    "import-x/resolver-next": [tsImportResolver]
  },
  rules: {
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "unused-imports/no-unused-imports": "error",
    "unused-imports/no-unused-vars": [
      "error",
      {
        vars: "all",
        varsIgnorePattern: "^_",
        args: "after-used",
        argsIgnorePattern: "^_"
      }
    ],

    /* Correctness / bug prevention. */
    "array-callback-return": ["error", { allowImplicit: true }],
    "consistent-return": ["error", { treatUndefinedAsUnspecified: true }],
    "default-case-last": "error",
    "default-param-last": "error",
    "dot-notation": "error",
    eqeqeq: ["error", "always", { null: "ignore" }],
    "no-await-in-loop": "error",
    "no-constant-binary-expression": "error",
    "no-constructor-return": "error",
    "no-debugger": "error",
    "no-dupe-else-if": "error",
    "no-dupe-keys": "error",
    "no-duplicate-case": "error",
    "no-duplicate-imports": "error",
    "no-implied-eval": "error",
    "no-loss-of-precision": "error",
    "no-misleading-character-class": "error",
    "no-new-native-nonconstructor": "error",
    "no-new-wrappers": "error",
    "no-promise-executor-return": "error",
    "no-prototype-builtins": "error",
    "no-return-assign": ["error", "always"],
    "no-return-await": "error",
    "no-self-compare": "error",
    "no-shadow": "off",
    "no-throw-literal": "error",
    "no-unassigned-vars": "error",
    "no-undef": "off",
    "no-unmodified-loop-condition": "error",
    "no-unreachable-loop": "error",
    "no-unsafe-optional-chaining": "error",
    "no-useless-assignment": "error",
    "no-useless-catch": "error",
    "no-useless-constructor": "error",
    "no-useless-escape": "error",
    "no-useless-return": "error",
    "no-with": "error",
    "prefer-object-has-own": "error",
    "prefer-regex-literals": "error",
    radix: ["error", "as-needed"],
    "require-atomic-updates": "error",
    "require-await": "error",
    yoda: ["error", "never", { exceptRange: true }],

    /* Repository policy / organization. */
    "no-console": "error",
    "no-restricted-syntax": ["error", ...baseRestrictedSyntax],
    "no-warning-comments": "off",

    /* TypeScript syntax-aware rules. */
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-shadow": "error",

    /* Import hygiene / coupling. */
    "import/export": "error",
    "import/first": "error",
    "import/max-dependencies": ["error", { max: 30, ignoreTypeImports: true }],
    "import/newline-after-import": ["error", { count: 1 }],
    "import/no-cycle": "error",
    "import/no-deprecated": "error",
    "import/no-duplicates": "error",
    "import/no-extraneous-dependencies": "error",
    "import/no-mutable-exports": "error",
    "import/no-self-import": "error",
    "import/no-unresolved": "error",
    "import/no-useless-path-segments": "error",
    "simple-import-sort/exports": "error",
    "simple-import-sort/imports": "error",

    /* SonarJS DRY/control-flow smells. */
    "sonarjs/cognitive-complexity": ["error", 20],
    "sonarjs/no-all-duplicated-branches": "error",
    "sonarjs/no-collapsible-if": "error",
    "sonarjs/no-duplicate-string": ["error", { threshold: 4 }],
    "sonarjs/no-duplicated-branches": "error",
    "sonarjs/no-identical-conditions": "error",
    "sonarjs/no-identical-expressions": "error",
    "sonarjs/no-identical-functions": "error",
    "sonarjs/no-ignored-exceptions": "error",
    "sonarjs/no-ignored-return": "error",
    "sonarjs/no-inverted-boolean-check": "error",
    "sonarjs/no-redundant-boolean": "error",
    "sonarjs/no-small-switch": "error",
    "sonarjs/no-sonar-comments": "error",
    "sonarjs/prefer-immediate-return": "error",

    /* Targeted allocation/runtime performance rules. */
    "e18e/no-spread-in-reduce": "error",
    "e18e/prefer-array-fill": "error",
    "e18e/prefer-array-from-map": "error",
    "e18e/prefer-includes-over-regex-test": "error",
    "e18e/prefer-slice-over-split-index": "error",
    "e18e/prefer-static-collator": "error",
    "e18e/prefer-static-regex": "error",

    /* Regex / security. */
    "regexp/no-super-linear-backtracking": "error",
    "regexp/optimal-quantifier-concatenation": "error",
    "security/detect-bidi-characters": "error",
    "security/detect-child-process": "error",
    "security/detect-eval-with-expression": "error",
    "security/detect-new-buffer": "error",
    "security/detect-unsafe-regex": "error",

    /* Promise hygiene. */
    "promise/no-multiple-resolved": "error",
    "promise/no-return-wrap": "error",

    /* Unicorn: keep correctness wins; avoid stylistic churn. */
    "unicorn/consistent-function-scoping": "error",
    "unicorn/error-message": "error",
    "unicorn/no-abusive-eslint-disable": "error",
    "unicorn/no-array-callback-reference": "off",
    "unicorn/no-array-for-each": "off",
    "unicorn/no-array-method-this-argument": "off",
    "unicorn/no-array-push-push": "error",
    "unicorn/no-array-reduce": "off",
    "unicorn/no-array-reverse": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/no-await-in-promise-methods": "error",
    "unicorn/no-empty-file": "error",
    "unicorn/no-hex-escape": "error",
    "unicorn/no-new-array": "error",
    "unicorn/no-null": "off",
    "unicorn/no-object-as-default-parameter": "error",
    "unicorn/no-this-assignment": "error",
    "unicorn/no-unreadable-array-destructuring": "error",
    "unicorn/no-useless-length-check": "error",
    "unicorn/no-useless-undefined": "off",
    "unicorn/no-zero-fractions": "error",
    "unicorn/prefer-array-some": "off",
    "unicorn/prefer-at": ["error", { checkAllIndexAccess: false }],
    "unicorn/prefer-code-point": "off",
    "unicorn/prefer-default-parameters": "off",
    "unicorn/prefer-single-call": "error",
    "unicorn/prefer-spread": "off",
    "unicorn/prefer-switch": "off",
    "unicorn/prefer-ternary": "off",
    "unicorn/prefer-top-level-await": "off",
    "unicorn/prevent-abbreviations": "off",

    /* Credential / disable-comment hygiene. */
    "no-secrets/no-secrets": [
      "error",
      {
        tolerance: 4.6,
        ignoreContent: ["-----BEGIN"],
        ignoreIdentifiers: ["API_KEY"]
      }
    ],
    "eslint-comments/no-unused-disable": "error",
    "eslint-comments/require-description": [
      "error",
      { ignore: ["eslint-enable", "eslint-env"] }
    ]
  }
});

export default defineConfig([
  { ignores: baseIgnorePatterns },

  /* Lint the lint tooling itself rather than leaving JS config unchecked. */
  {
    files: ["eslint.config.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.node
    }
  },

  ...tsConfig,

  /* Classified source dependencies are default-deny and mirror the documented layers. */
  {
    files: ["src/**/*.ts", "tests/**/*.ts", ".rulesync/skills/**/*.ts"],
    plugins: { boundaries: pluginBoundaries },
    settings: {
      "boundaries/elements": architectureElements,
      "boundaries/elements-single-type": true,
      "boundaries/include": ["src/**/*", "tests/**/*", ".rulesync/skills/**/*"],
      // eslint-plugin-boundaries resolves imports through eslint-module-utils,
      // which uses the legacy resolver settings rather than import-x's resolver-next API.
      "import/resolver": {
        typescript: { project: ["./tsconfig.json"] }
      },
      "boundaries/legacy-warnings": false
    },
    rules: {
      "boundaries/no-unknown-files": "error",
      "boundaries/no-unknown-dependencies": ["error", { require: "any" }],
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          checkUnknownLocals: false,
          policies: architecturePolicies
        }
      ]
    }
  },

  /* Pure shared primitives get the tightest KISS/coupling ceiling. */
  {
    files: ["src/shared/**/*.ts"],
    rules: {
      complexity: ["error", { max: 20 }],
      "import/max-dependencies": [
        "error",
        { max: 12, ignoreTypeImports: true }
      ],
      "max-lines": [
        "error",
        { max: 400, skipBlankLines: true, skipComments: true }
      ],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true }
      ],
      "max-params": ["error", 5],
      "max-statements": ["error", 50],
      "no-param-reassign": ["error", { props: true }],
      "sonarjs/cognitive-complexity": ["error", 15]
    }
  },

  /* Tests keep correctness/import rules while retaining bounded fixture headroom. */
  {
    files: TEST_FILES,
    plugins: { ...typeScriptPlugin },
    rules: {
      complexity: ["error", { max: 35 }],
      "import/max-dependencies": "off",
      "max-lines": "off",
      "max-lines-per-function": "off",
      "max-nested-callbacks": ["error", 6],
      "max-statements": "off",
      "no-await-in-loop": "off",
      // Tests stub a process-global property (globalThis.fetch, process.env.X)
      // and restore it in a finally block after awaited work; node:test runs a
      // file's tests sequentially, so those property restores are not races.
      "require-atomic-updates": ["error", { allowProperties: true }],
      "no-console": "off",
      "no-implicit-coercion": "off",
      "no-promise-executor-return": "off",
      "no-restricted-syntax": ["error", ...focusedTestRestrictedSyntax],
      "no-secrets/no-secrets": "off",
      "no-throw-literal": "off",
      "require-await": "off",
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-identical-functions": "off",
      // A runtime-allocation rule: a regex literal in an assertion runs once,
      // and hoisting hundreds of them away from their assertions would cost
      // readability for no gain.
      "e18e/prefer-static-regex": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/import-style": "off",
      "unicorn/no-await-expression-member": "off",
      "unicorn/no-useless-undefined": "off",
      "unicorn/prefer-module": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off"
    }
  },

  eslintConfigPrettier
]);
