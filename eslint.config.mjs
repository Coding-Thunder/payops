import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
      // Generated test output. The Playwright HTML reporter bundles its own
      // minified app into reports/playwright-html, which ESLint would
      // otherwise lint — phantom errors in generated code no one can act on.
      // `/reports` is already gitignored.
      "reports/**",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
  ]),
]);

export default eslintConfig;
