# Contributing to StellarSplit SDK

Thank you for your interest in contributing to **StellarSplit SDK** — the open-source TypeScript toolkit for Stellar-based split payments, invoicing, and multi-wallet management. This project is part of the [Drips Wave Program](https://drips.network/wave), a monthly open-source bounty initiative run by the Stellar Development Foundation.

---

## Table of Contents

1. [Introduction](#introduction)
2. [Prerequisites](#prerequisites)
3. [Fork & Clone Workflow](#fork--clone-workflow)
4. [Branch Naming Conventions](#branch-naming-conventions)
5. [Commit Message Format](#commit-message-format)
6. [Development Setup](#development-setup)
7. [Code Style](#code-style)
8. [Testing](#testing)
9. [Pull Request Process](#pull-request-process)
10. [Issue Workflow](#issue-workflow)
11. [Architecture Overview](#architecture-overview)
12. [Security Guidelines](#security-guidelines)
13. [Contributor Checklist](#contributor-checklist)
14. [Templates](#templates)
15. [Worked Example](#worked-example)
16. [FAQ](#faq)

---

## Introduction

StellarSplit SDK is a TypeScript-first library that provides:

- **Invoice management** — create, fund, track, and settle payment invoices on Stellar
- **Multi-wallet support** — connect MetaMask, WalletConnect, Ledger, Freighter, and more
- **Batch operations** — group payments and Soroban contract calls for efficiency
- **SEP integrations** — SEP-31 cross-border payments, SEP-10 auth, and more
- **Telemetry and observability** — hooks for error monitoring, performance tracking

We welcome contributions of all sizes — from typo fixes in docs to large new features. Every issue in our tracker is a candidate for community contribution. Please read this guide in full before opening a pull request.

> **Important:** Do not begin coding until a maintainer has assigned you to an issue. Comment on the issue first and wait for assignment.

---

## Prerequisites

Before contributing, ensure your local environment meets the following requirements:

| Tool    | Minimum Version | Recommended | Notes |
|---------|----------------|-------------|-------|
| Node.js | 18.x           | 20.x LTS    | Required for ESM + top-level await support |
| npm     | 9.x            | 10.x        | Bundled with Node.js |
| Git     | 2.35+          | latest      | Required for signed commits |
| TypeScript | 5.x         | 5.4+        | Installed as dev dependency |

### Verify your environment

```bash
node --version   # should output v18.x or higher
npm --version    # should output 9.x or higher
git --version    # should output 2.35 or higher
```

### Optional but recommended

- **[Visual Studio Code](https://code.visualstudio.com/)** — recommended editor with TypeScript IntelliSense
- **ESLint + Prettier VSCode extensions** — for real-time lint feedback
- **GitHub CLI (`gh`)** — for branch creation and PR management from the terminal

---

## Fork & Clone Workflow

### 1. Fork the repository

Click **Fork** on the [Stellar-split/split-sdk](https://github.com/Stellar-split/split-sdk) repository page to create your own copy.

### 2. Clone your fork

```bash
git clone https://github.com/<your-username>/split-sdk.git
cd split-sdk
```

### 3. Add the upstream remote

This allows you to pull in changes from the main repository:

```bash
git remote add upstream https://github.com/Stellar-split/split-sdk.git
git fetch upstream
```

### 4. Verify your remotes

```bash
git remote -v
# origin    https://github.com/<your-username>/split-sdk.git (fetch)
# origin    https://github.com/<your-username>/split-sdk.git (push)
# upstream  https://github.com/Stellar-split/split-sdk.git (fetch)
# upstream  https://github.com/Stellar-split/split-sdk.git (push)
```

### 5. Keep your fork in sync

Before starting any new work, always sync with upstream:

```bash
git checkout main
git fetch upstream
git merge upstream/main
git push origin main
```

---

## Branch Naming Conventions

Create a feature branch from `main`. Use the following prefixes to indicate the type of change:

| Prefix    | Purpose                                      | Example |
|-----------|----------------------------------------------|---------|
| `feat/`   | New feature or capability                    | `feat/issue-1130-freighter-adapter` |
| `fix/`    | Bug fix                                      | `fix/issue-42-null-address-crash` |
| `docs/`   | Documentation changes only                  | `docs/issue-1081-contribution-guide` |
| `chore/`  | Tooling, build, CI, dependencies             | `chore/upgrade-vitest-2.0` |
| `refactor/` | Code refactoring with no behavior change  | `refactor/split-calculator-cleanup` |
| `test/`   | Adding or improving tests only               | `test/invoice-state-machine-coverage` |
| `perf/`   | Performance improvements                     | `perf/batch-payment-optimization` |

### Branch naming format

```
<prefix>/issue-<NUMBER>-short-description
```

```bash
# Examples
git checkout -b feat/issue-1130-freighter-adapter
git checkout -b fix/issue-42-null-address-crash
git checkout -b docs/issue-1081-contribution-guide
```

Keep descriptions short (3–5 words), lowercase, hyphenated. **Never commit directly to `main`.**

---

## Commit Message Format

This project follows the [Conventional Commits](https://www.conventionalcommits.org/) specification. All commit messages must follow this format:

```
<type>(<optional scope>): <short description>

[optional body]

[optional footer(s)]
```

### Commit types

| Type       | When to use |
|------------|-------------|
| `feat`     | A new feature |
| `fix`      | A bug fix |
| `docs`     | Documentation only changes |
| `style`    | Code formatting, missing semicolons (no logic changes) |
| `refactor` | Code restructuring without feature/bug change |
| `test`     | Adding or updating tests |
| `chore`    | Build process, tooling, dependency updates |
| `perf`     | Performance improvements |
| `ci`       | CI/CD configuration changes |
| `revert`   | Reverting a previous commit |

### Examples

```
feat(wallet): add FreighterAdapter for Stellar browser extension (#1130)

fix(invoice): handle undefined return from freighter signTransaction (#42)

docs(contributing): add Conventional Commits guidance (#1081)

test(batch): add coverage for 101-operation rejection case

chore: upgrade vitest to 2.0.0
```

### Rules

- Subject line: **≤ 72 characters**, **imperative mood** ("add feature", not "added feature")
- Reference the issue in the footer or subject: `(#42)` or `Closes #42`
- Use the body to explain **why**, not just **what**
- Keep commits atomic — one logical change per commit

### Setting up commit linting locally (optional)

```bash
npm install --save-dev @commitlint/cli @commitlint/config-conventional
# Add to package.json: "commitlint": { "extends": ["@commitlint/config-conventional"] }
```

---

## Development Setup

### 1. Install dependencies

```bash
npm install
```

> If you encounter peer dependency conflicts, use:
> ```bash
> npm install --legacy-peer-deps
> ```

### 2. Build the project

```bash
npm run build
```

This compiles TypeScript to the `dist/` directory using the project's `tsconfig.json`.

### 3. Run in watch mode (optional)

```bash
npm run build -- --watch
```

### 4. Type-check without emitting

```bash
npx tsc --noEmit
```

### 5. Lint your code

```bash
npm run lint
```

### Environment variables

The SDK does not require environment variables for development. If you are running integration tests against a real Stellar testnet, you may optionally set:

```bash
STELLAR_NETWORK=testnet
HORIZON_URL=https://horizon-testnet.stellar.org
```

---

## Code Style

StellarSplit SDK enforces **TypeScript strict mode** across the entire codebase. The following rules are non-negotiable:

### TypeScript strict configuration

The `tsconfig.json` enables:

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noUncheckedIndexedAccess": true
  }
}
```

### Code style rules

1. **No `any` types.** Use `unknown` and narrow with type guards instead. If `any` is truly unavoidable, add a comment explaining why.
2. **Explicit return types** on all exported functions and class methods.
3. **JSDoc comments** on all exported functions, classes, and interfaces.
4. **Prefer `const`** over `let`. Avoid `var`.
5. **No unused imports** — remove them before committing.
6. **Use `.js` extensions** in all import paths (required for ESM compatibility):
   ```typescript
   import { StellarSplitError } from './errors.js';  // ✅
   import { StellarSplitError } from './errors';      // ❌
   ```
7. **Error handling** — always extend `StellarSplitError` for SDK errors, never throw raw strings.
8. **Async/await** preferred over `.then()` chains.
9. **Keep functions small** — aim for ≤ 40 lines per function. Extract helpers.
10. **Immutable data** — prefer `readonly` modifiers on interface properties.

### Example of correct style

```typescript
/**
 * Fetches the current balance for a Stellar account.
 * @param accountId - The Stellar public key to query.
 * @param asset - The asset to look up, defaults to XLM.
 * @returns The balance as a string with 7 decimal places.
 * @throws {@link StellarSplitError} when the account does not exist.
 */
export async function getAccountBalance(
  accountId: string,
  asset: Asset = Asset.native()
): Promise<string> {
  // ...
}
```

---

## Testing

### Test runner

The project uses **[Vitest](https://vitest.dev/)** as the test runner. Tests are located in the `test/` directory.

### Running all tests

```bash
npm test
```

### Running a specific test file

```bash
npm test -- freighterAdapter
npm test -- batchOperations.test.ts
```

### Running with verbose output

```bash
npm test -- --reporter=verbose
```

### Watching tests during development

```bash
npm test -- --watch
```

### Writing new tests

All new functionality **must** include tests. Test files should:

- Live in `test/` and follow the pattern `<FeatureName>.test.ts`
- Use `describe` blocks to group related cases
- Use `it` for individual test cases (descriptive names)
- Use `vi.fn()` and `vi.mock()` for mocking dependencies

Example test structure:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MyFeature } from '../src/myFeature.js';

describe('MyFeature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the correct result for valid input', () => {
    const result = MyFeature.compute('valid-input');
    expect(result).toBe('expected-output');
  });

  it('throws MyError when input is invalid', () => {
    expect(() => MyFeature.compute('')).toThrow(MyError);
  });
});
```

### Test coverage expectations

- New features: **aim for ≥ 90% coverage** on the new code
- Bug fixes: add a test that **reproduces the bug** before the fix
- Run coverage report: `npm test -- --coverage`

---

## Pull Request Process

### Before submitting

Ensure all of the following are true:

- [ ] Your branch is up-to-date with `upstream/main`
- [ ] `npm test` passes (all tests green)
- [ ] `npm run lint` passes with no errors
- [ ] `npx tsc --noEmit` passes with no type errors
- [ ] New code has corresponding tests
- [ ] All exported symbols have JSDoc comments
- [ ] The PR references the issue it closes

### PR title format

Follow Conventional Commits format for the PR title:

```
feat(wallet): add FreighterAdapter for Stellar browser extension
```

### PR description template

```markdown
## Summary
Brief description of what this PR does.

## Changes
- Added `FreighterAdapter` implementing `WalletAdapter`
- Exported from `multiWallet.ts`
- Added test suite in `test/freighterAdapter.test.ts`

## Testing
Describe how you tested the changes.

## Related Issues
Closes #1130
```

### Review process

1. Submit the PR — a maintainer will review within a few business days.
2. Address any requested changes by pushing additional commits to your branch (do not force-push unless asked).
3. Once approved, a maintainer will squash-merge your PR.
4. Your issue will be closed automatically when the PR is merged.

---

## Issue Workflow

### How to get assigned to an issue

1. Browse [open issues](https://github.com/Stellar-split/split-sdk/issues) and find one labeled `good first issue`, `help wanted`, or matching your skill level.
2. **Read the full issue description** including any linked discussions.
3. Comment: *"I'd like to work on this."*
4. **Wait for a maintainer to assign you.** Do not fork and start coding before assignment.
5. Only one contributor per issue at a time — respect active assignments.

### How to report bugs

1. Search [existing issues](https://github.com/Stellar-split/split-sdk/issues) to check if the bug is already reported.
2. If not found, open a new issue using the **Bug Report** template.
3. Include:
   - SDK version (`npm list split-sdk`)
   - Node.js version
   - Minimal reproduction code snippet
   - Expected vs. actual behavior
   - Stack trace if applicable

### How to request a feature

1. Open a [Discussion](https://github.com/Stellar-split/split-sdk/discussions) first to gauge interest.
2. If the maintainers support it, they will open a tracked issue.
3. Feature requests become issues only when they are scoped and actionable.

### Asking questions

- Use [GitHub Discussions](https://github.com/Stellar-split/split-sdk/discussions) — not issues — for questions.
- For quick questions, comment on the relevant issue thread.

---

## Architecture Overview

Understanding the repository layout will help you find where to make changes.

```
split-sdk/
├── src/                    # All library source code (TypeScript)
│   ├── index.ts            # Public API entry point — re-exports all public symbols
│   ├── client.ts           # StellarSplitClient — main SDK facade
│   ├── errors.ts           # StellarSplitError base class and typed subclasses
│   ├── types.ts            # Shared TypeScript interfaces and type definitions
│   ├── multiWallet.ts      # MultiWalletManager and wallet adapter re-exports
│   ├── wallets/
│   │   └── adapters/       # Concrete WalletAdapter implementations
│   │       ├── FreighterAdapter.ts
│   │       ├── MetaMaskAdapter.ts
│   │       ├── LobstrAdapter.ts
│   │       └── XBullAdapter.ts
│   ├── adapters/           # Additional adapters (WalletConnect, Ledger)
│   ├── invoice/            # Invoice creation, state machine, diff utilities
│   ├── payments/           # Payment flows, batch operations, routing
│   ├── sep/                # SEP-10, SEP-31 protocol implementations
│   ├── soroban/            # Soroban contract interaction utilities
│   ├── horizon/            # Stellar Horizon API client wrappers
│   ├── telemetry/          # Telemetry hooks, metrics, OTEL export
│   └── utils/              # General-purpose utilities
├── test/                   # Vitest test suites (*.test.ts)
├── docs/                   # Supplementary documentation
│   ├── INTEGRATION_TESTING.md
│   ├── MIGRATION.md
│   ├── SIGNING_VAULT.md
│   └── ...
├── dist/                   # Compiled output (do not edit — git-ignored)
├── CONTRIBUTING.md         # This file
├── CHANGELOG.md            # Version history and notable changes
├── package.json
└── tsconfig.json
```

### Key design patterns

- **Adapter pattern** — all wallet integrations implement the `WalletAdapter` interface from `types.ts`
- **Error hierarchy** — all SDK errors extend `StellarSplitError` with a `code` string for programmatic handling
- **Event emitters** — typed event emitters (`TypedEventEmitter`) for observable state changes
- **Pure functions** — utility modules (e.g., `diff.ts`, `paymentSplitCalculator.ts`) are side-effect-free

---

## Security Guidelines

Security vulnerabilities must **not** be reported in public GitHub issues. Follow these guidelines:

### Reporting a vulnerability

1. Email the maintainers privately at the address listed in `SECURITY.md`.
2. Provide: description, steps to reproduce, affected versions, and potential impact.
3. Allow **14 days** for an initial response before public disclosure.
4. We aim to release a fix within **90 days** of confirmed reports.

### Security best practices for contributors

- **Never commit private keys, secrets, or API tokens** — not even testnet keys.
- Use `.env` for local secrets and ensure `.env` is in `.gitignore`.
- Validate all external input — treat Horizon API responses as untrusted.
- Use `StellarSplitError` subclasses — never leak internal stack traces to end users.
- When implementing cryptographic operations, use established libraries (e.g., `@stellar/stellar-sdk`) — do not roll your own.
- Avoid `eval()`, `Function()`, or dynamic `import()` with user-controlled strings.
- Dependencies: check `npm audit` before adding new packages.

```bash
npm audit
npm audit fix
```

---

## Contributor Checklist

Use this checklist before every pull request submission:

### Setup
- [ ] I have read the full CONTRIBUTING.md
- [ ] My Node.js version is 18 or higher
- [ ] I was assigned to this issue before I started coding
- [ ] I created a branch with the correct naming convention

### Code quality
- [ ] My code compiles without TypeScript errors (`npx tsc --noEmit`)
- [ ] I did not introduce any `any` types without explanation
- [ ] All new exported functions and classes have JSDoc comments
- [ ] Import paths end with `.js` for ESM compatibility
- [ ] I extended `StellarSplitError` for any new error classes

### Tests
- [ ] I wrote tests for all new functionality
- [ ] All existing tests pass (`npm test`)
- [ ] My tests cover both success paths and error paths

### Documentation
- [ ] I updated the relevant docs if behavior changed
- [ ] I updated `CHANGELOG.md` under the `Unreleased` section

### PR hygiene
- [ ] My branch is rebased on current `upstream/main`
- [ ] My PR title follows Conventional Commits format
- [ ] My PR description references the closed issue (`Closes #NNN`)
- [ ] I have not included unrelated changes

---

## Templates

Ready-to-use templates live in `.github/`:

| Template | Location | Use for |
|----------|----------|---------|
| Pull request | `.github/PULL_REQUEST_TEMPLATE.md` | Applied automatically when you open a PR |
| Bug report | `.github/ISSUE_TEMPLATE/bug_report.md` | Reporting broken behavior |
| Feature request | `.github/ISSUE_TEMPLATE/feature_request.md` | Proposing new SDK capabilities |
| Trivial / medium / high task | `.github/ISSUE_TEMPLATE/{trivial,medium,high}.md` | Maintainer-scoped work items |

---

## Worked Example

A typical contribution, end to end (replace `1130` and names with your own):

```bash
# 1. After being assigned to issue #1130, sync and branch
git fetch upstream && git checkout -b feat/freighter-adapter upstream/main

# 2. Implement, with tests next to the existing ones
#    src/freighterAdapter.ts, test/freighterAdapter.test.ts

# 3. Verify locally
npm run lint
npx vitest run test/freighterAdapter.test.ts

# 4. Commit using Conventional Commits and push to your fork
git commit -am "feat(wallet): add FreighterAdapter"
git push origin feat/freighter-adapter
```

Then open a PR against `main` with `Closes #1130` in the description.

---

## FAQ

**Can I start working on an issue without being assigned?**
No. Comment on the issue and wait for a maintainer to assign you, otherwise the PR may be closed.

**Which command runs the tests?**
`npm test` runs the core suite. Use `npx vitest run <file>` for a single file and `npm run test:all` for everything.

**How do I type-check?**
`npm run lint` runs `tsc --noEmit`.

**Why do imports end in `.js`?**
The project is ESM; TypeScript source imports must use the `.js` extension.

**My PR is out of date with `main`. What do I do?**
Rebase on `upstream/main` (see "Keep your fork in sync") and push. Do not force-push unless a reviewer asks.

**Do I need to update the changelog?**
Yes, for user-visible changes add an entry under `Unreleased` in `CHANGELOG.md`.

**How do I report a security issue?**
Do not open a public issue. Follow [Security Guidelines](#security-guidelines).

---

*Thank you for contributing to StellarSplit SDK! Every contribution — large or small — helps make Stellar payments more accessible for developers worldwide.*
