# Task 1 Report

## Changed files

- `src/index.ts`
  - Removed `installCompletionNotifier` and its terminal-state/debounce logic.
  - Removed notifier-only timer dependencies and `Text` import.
  - Removed automatic message renderer registration and notifier lifecycle wiring.
  - Preserved tool registration, dashboard registration/cleanup, config loading, profile discovery, and single awaited manager shutdown.
- `test/tools.test.ts`
  - Added the runtime regression test for absent automatic completion registration/emission.
  - Removed obsolete notifier and renderer tests, fake timer support, and notifier-only fake fields.
  - Removed notifier-only dependency values and the old renderer assertion.

## RED evidence

Command:

```bash
npx tsx --test --test-name-pattern="runtime does not register or emit automatic completion messages" test/tools.test.ts
```

Result: failed as expected before the production change. The regression assertion reported `1 !== 0` for `pi.sendAttempts`, proving the existing notifier emitted a message.

## GREEN and full verification

Focused test after the change:

```bash
npx tsx --test --test-name-pattern="runtime does not register or emit automatic completion messages" test/tools.test.ts
```

Result: passed, 1 test, 0 failures.

Type check:

```bash
npm run typecheck
```

Result: passed with no TypeScript errors.

Full suite:

```bash
npm test
```

Result: 188 tests reported, 186 passed, 2 skipped, 0 failed.

Additional checks: `git diff --check` passed; the working tree is clean after commit. No Task 2 changes or wait timeout changes were made.

## Self-review

The extension lifecycle now has the required shape: session start only loads config/profiles and reports diagnostics; session shutdown removes dashboard UI, initializes `manager.shutdown()` once, and awaits it. The normal tools and dashboard registration remain in place. The new runtime test waits 150 ms, so it covers the old 100 ms notifier debounce path. The remaining timer dependencies found in the repository belong to process cancellation and job waiting, not the removed notifier.

## Commit

`afb454a7969aeea07a169b84919428db6e07c3b0` — `refactor: remove subagent completion notices`

## Fix Round 1

Smallest test-harness correction: added `FakePi.sendMessage(): void { this.sendAttempts += 1; }` so the regression detects attempted automatic emission.

Focused regression:

```bash
npx tsx --test --test-name-pattern="runtime does not register or emit automatic completion messages" test/tools.test.ts
```

Result: passed, 1 test, 0 failures.

Full `test/tools.test.ts`:

```bash
npx tsx --test test/tools.test.ts
```

Result: 37 tests reported, 37 passed, 0 failed.

Type check:

```bash
npm run typecheck
```

Result: passed; `tsc --noEmit` completed with no errors.
