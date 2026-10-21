import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-e2e/**",
      "test-results/**",
      "playwright-report/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Money and quantities must never be JavaScript floats; parseFloat is banned in source.
      "no-restricted-globals": ["error", { name: "parseFloat", message: "Use Money/Qty parsers." }],
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: "Use Money/Qty parsers." },
      ],
    },
  },
);
