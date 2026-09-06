# SQLVec-DB-Core Coverage Hardening Plan

## Objective

Achieve **≥95% coverage in every metric** (Statements, Branch, Functions, Lines)
across **all 394 source files** in `sqlvec-db-core`.

Current baseline: **9.24% statements / 6.13% branch / 9.96% functions / 9.89% lines**.

The primary goal is not the metric itself but **discovering and fixing real bugs**.
Every test must be *real and effective* — no tautological assertions, no
`expect(true).toBe(true)`, no calling dead code just to inflate numbers.

## Guiding Principles

1. **Bug-first**: each new test targets genuine behavior; if a test exposes a
   defect, fix the defect in the source, then re-verify.
2. **No mocks where real integration is possible**: prefer real engine instances.
   Mock only external boundaries (network, heavy native deps, entropy/time).
3. **Scientific rigor**: every iteration states its hypothesis (which module,
   which uncovered lines), the test method, and an explicit acceptance gate.
4. **Deterministic**: tests must not depend on wall-clock timing, random
   ordering, or ambient filesystem state.
5. **English only** for code comments, documentation, and commit messages.

## Module Coverage Map (baseline)

| Tier | Modules | Current | Notes |
|------|---------|---------|-------|
| P0 (zero coverage, core logic) | backup, commitlog, config, encryption, executor, ha, lock, ops, pipeline, pitr, pool, recovery, replication, server, tracing, utils | 0% | high-value engine internals |
| P1 (single-largest surface) | query (226 files) | 8.54% | DSL/operator/expression layer |
| P2 (partial) | storage (8.96), index (2.46), vector (4.98), system (16.82), analytics (8.74), logger (26.89), monitoring (40), tde (1.91), plpgsql (0.09) | <50% | substantial logic |
| P3 (near target) | constants (98.11), types (92.7) | >90% | close, branch/funcs lag |
| P4 (trivial/type-only) | interfaces, error/errors, pg_stats, pgwire, constraint, consensus | mixed | mostly type shims |

## Execution Strategy

Iterate bottom-up from smallest, highest-leverage modules first, then tackle the
`query` surface last (largest count, most mechanical).

### Iteration Template

Each iteration documents:

1. **Hypothesis**: which files, why untested, expected behavior.
2. **Method**: unit vs integration, setup/fixtures, mocked boundaries.
3. **Test cases**: enumerated, one per behavioral branch.
4. **Acceptance gate**: `npx vitest run --coverage` shows the target module
   ≥95% on all four metrics AND zero failing tests AND no new failures introduced.
5. **Bug log**: any defect found + fix commit hash.

## Acceptance Criteria (definition of done)

- [ ] `All files` row reports ≥95% for %Stmts, %Branch, %Funcs, %Lines.
- [ ] Full suite green: `npx vitest run` exits 0.
- [ ] `npx tsc --noEmit` passes with zero errors.
- [ ] No skipped tests used to mask gaps (skips counted as uncovered).
- [ ] Coverage excludes only `src/__tests__/**` and `src/types/vendor/**`.
- [ ] Every commit authored by `Lambertyan`, English comments/messages.

## Bug Ledger

| # | File | Description | Status |
|---|------|-------------|--------|
| 1 | src/__tests__/smoke.test.ts | `beforeAll` timeout 15s < real `db.start()` ~16s | FIXED (timeout→60s) |

## Progress Log

- 2026-09-06: baseline captured; plan written; smoke timeout bug fixed.
