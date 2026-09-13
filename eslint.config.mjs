import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/target/**",
      "**/node_modules/**",
      "apps/web/next-env.d.ts",
      "packages/database/src/database.types.ts",
      "playwright-report/**",
      "test-results/**",
      "artifacts/**",
    ],
  },
  {
    settings: { next: { rootDir: "apps/web/" } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "import/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
            "object",
            "type",
          ],
          pathGroups: [
            {
              pattern: "@scout/**",
              group: "internal",
              position: "before",
            },
            {
              pattern: "@/**",
              group: "internal",
              position: "after",
            },
          ],
          pathGroupsExcludedImportTypes: ["builtin", "type"],
          distinctGroup: false,
          "newlines-between": "always",
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
            orderImportKind: "asc",
          },
          warnOnUnassignedImports: true,
        },
      ],
      "one-var": ["error", "never"],
      "padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "directive", next: "*" },
        { blankLine: "any", prev: "directive", next: "directive" },
        { blankLine: "always", prev: "import", next: "*" },
        { blankLine: "any", prev: "import", next: "import" },
        {
          blankLine: "always",
          prev: ["const", "let", "var"],
          next: "*",
        },
        {
          blankLine: "always",
          prev: "*",
          next: ["const", "let", "var"],
        },
        {
          blankLine: "any",
          prev: ["const", "let", "var"],
          next: ["const", "let", "var"],
        },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "*", next: "block-like" },
        { blankLine: "always", prev: "export", next: "*" },
        { blankLine: "always", prev: "*", next: "export" },
        { blankLine: "always", prev: "*", next: ["return", "throw"] },
        {
          blankLine: "always",
          prev: ["function", "class"],
          next: "*",
        },
        {
          blankLine: "always",
          prev: "*",
          next: ["function", "class"],
        },
      ],
      "prefer-const": "error",
      "sort-imports": [
        "error",
        {
          allowSeparatedGroups: true,
          ignoreCase: true,
          ignoreDeclarationSort: true,
          ignoreMemberSort: false,
        },
      ],
    },
  },
];

export default config;
