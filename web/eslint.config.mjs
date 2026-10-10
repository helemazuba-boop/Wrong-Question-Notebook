import coreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';

const eslintConfig = [
  ...coreWebVitals,
  ...nextTypescript,
  prettierConfig,
  {
    // Must match eslint-config-next's glob: the `react-hooks` plugin it
    // registers is itself scoped to these files, and ESLint only resolves a
    // plugin from configs that apply to the file being linted.
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      // Prettier integration
      'prettier/prettier': 'error',

      // TypeScript specific rules
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          // A leading underscore marks an intentionally-unused binding
          // (e.g. destructuring to omit a field: `const { auth: _auth, ...rest }`).
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // General code quality rules
      'prefer-const': 'error',
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-debugger': 'error',

      // React specific rules
      'react-hooks/exhaustive-deps': 'warn',
      'react/no-unescaped-entities': 'off',

      // Debt: eslint-config-next 16 pulls eslint-plugin-react-hooks 5 -> 7,
      // which introduces these seven rules. They flag 77 pre-existing call
      // sites across 49 files (52 alone are set-state-in-effect), none of
      // which were violations under the old plugin. Fixing them means
      // rewriting effect and state-initialisation logic, which changes runtime
      // behaviour and needs manual UI regression testing per screen.
      //
      // Downgraded to warnings so the upgrade can land without bundling a
      // behavioural refactor into a dependency bump. Each should be tightened
      // back to 'error' as its call sites are fixed.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/incompatible-library': 'warn',
    },
  },
  {
    // UI convergence guard rails (see CONTRIBUTING.md, "UI 约定").
    // No server component under app/[locale] uses fetch today (they read
    // via services), so this only flags client-side call sites.
    files: ['app/[locale]/**/*.tsx', 'components/**/*.tsx'],
    rules: {
      // Browser→API requests must go through lib/api-client.ts so envelope
      // unwrapping and error normalization stay in one place. Warning while
      // the existing call sites migrate; tighten to 'error' as they convert.
      'no-restricted-syntax': [
        'warn',
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            'Use lib/api-client.ts (apiGet/apiPost/…) instead of bare fetch in UI code.',
        },
      ],
    },
  },
  {
    // New UI primitives must stay composable; the known oversized files
    // warn until they are split (refactor plan M2c).
    files: ['components/**/*.tsx'],
    rules: {
      'max-lines': [
        'warn',
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'dist/**',
      'playwright-report/**',
      'test-results/**',
      '*.d.ts',
      'package-lock.json',
      'yarn.lock',
    ],
  },
  {
    files: ['tailwind.config.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // CommonJS files legitimately use require(); the rule is for ESM.
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/__tests__/**/*.test.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
  },
];

export default eslintConfig;
