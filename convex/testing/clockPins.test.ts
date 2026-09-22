// @vitest-environment node
/**
 * M08 recurrence guard for D138, the calendar time-bomb.
 *
 * Every public query that takes `now` validates it against the server clock
 * (`watches.assertCoarseNow`, ±24 h of `Date.now()`). A test that passes a
 * FIXED time such as `{ now: Date.UTC(2026, 8, 21, 12) }` without pinning the
 * clock is green on the day it is written and red from the next day on. That
 * is exactly what broke `convex/tracking.test.ts` on 2026-09-22.
 *
 * This test parses every collected test file with the TypeScript compiler
 * and fails on any call
 *   `<x>.query|mutation|action|runQuery|runMutation|runAction(api.…, { now: <fixed> })`
 * that is not covered by a clock pin in scope. It checks public functions
 * only (`api.*`, not `internal.*`).
 *
 * What counts as `<fixed>`: `Date.UTC(…)`, `Date.parse("…")`,
 * `new Date(<literal>).getTime()` / `.valueOf()` / unary `+`, a numeric
 * literal ≥ 1e12 (epoch ms), `+`/`-` arithmetic on any of these, and a
 * `const`/`let`/`var` whose initializer is one of these, resolved through
 * the nearest enclosing declaration (so `{ now: NOW }` and the `{ now }`
 * shorthand both count). `Date.now()`-based values, parameters and
 * destructured values do not count.
 *
 * What counts as a pin in scope: `vi.setSystemTime(…)`, `pinClock(…)`,
 * `pinClockEach(…)` or `vi.useFakeTimers({ now: … })`. It must be inside the
 * calling test, or in the file or an enclosing `describe` (including its
 * `beforeEach`/`beforeAll`). A pin inside a SIBLING test does not count. A
 * call made from a helper outside any test is accepted if the file pins
 * anywhere.
 *
 * Escape hatch, for a fixed time that is valid on any date (e.g. asserting
 * that a far-past time is rejected): put `// clock-lint: allow <reason>` on
 * the line of the call or the line above it.
 *
 * Proof it has teeth: the synthetic cases below include the pre-fix D138
 * shape (flagged) and its fixed form (not flagged). Scanning the pre-fix
 * `convex/tracking.test.ts` (`git show f128bf4^:convex/tracking.test.ts`)
 * flags both D138 calls (lines 317 and 401); see the M08 doc.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_CALL_METHODS = new Set(["query", "mutation", "action", "runQuery", "runMutation", "runAction"]);
const TEST_BLOCK_NAMES = new Set(["it", "test", "describe", "suite"]);
const PIN_FUNCTIONS = new Set(["pinClock", "pinClockEach"]);
const ALLOW_MARKER = "clock-lint: allow";
const EPOCH_MS_FLOOR = 1e12; // 2001-09-09; smaller numbers are durations, not instants

export type ClockFinding = { file: string; line: number; text: string };

function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function isDateMember(node: ts.Expression, member: string): boolean {
  const n = unwrap(node);
  return ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Date" && n.name.text === member;
}

function isLiteralArg(node: ts.Expression): boolean {
  const n = unwrap(node);
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n);
}

function isNewDateWithLiteral(node: ts.Expression): boolean {
  const n = unwrap(node);
  return ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Date" && (n.arguments?.length ?? 0) > 0 && n.arguments!.every(isLiteralArg);
}

/** Finds the nearest enclosing declaration of `name` visible from `from` (block-scoped approximation). */
function resolveDeclaration(name: string, from: ts.Node): ts.VariableDeclaration | "opaque" | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      for (const p of scope.parameters) {
        if (bindingHasName(p.name, name)) return "opaque";
      }
    }
    const statements: readonly ts.Statement[] | undefined =
      ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) ? scope.statements : undefined;
    if (!statements) continue;
    for (const st of statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const decl of st.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
        if (!ts.isIdentifier(decl.name) && bindingHasName(decl.name, name)) return "opaque";
      }
    }
  }
  return undefined;
}

function bindingHasName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((el) => !ts.isOmittedExpression(el) && bindingHasName(el.name, name));
}

function isFixedTime(node: ts.Expression, depth = 0): boolean {
  if (depth > 8) return false;
  const n = unwrap(node);
  if (ts.isNumericLiteral(n)) return Number(n.text.replace(/_/g, "")) >= EPOCH_MS_FLOOR;
  if (ts.isCallExpression(n)) {
    if (isDateMember(n.expression, "UTC")) return true;
    if (isDateMember(n.expression, "parse")) return n.arguments.length > 0 && isLiteralArg(n.arguments[0]);
    const callee = unwrap(n.expression);
    if (ts.isPropertyAccessExpression(callee) && (callee.name.text === "getTime" || callee.name.text === "valueOf")) {
      return isNewDateWithLiteral(callee.expression);
    }
    return false;
  }
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.PlusToken) return isNewDateWithLiteral(n.operand);
  if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.PlusToken || n.operatorToken.kind === ts.SyntaxKind.MinusToken)) {
    return isFixedTime(n.left, depth + 1) || isFixedTime(n.right, depth + 1);
  }
  if (ts.isIdentifier(n)) {
    const decl = resolveDeclaration(n.text, n);
    if (!decl || decl === "opaque" || !decl.initializer) return false;
    return isFixedTime(decl.initializer, depth + 1);
  }
  return false;
}

function rootIdentifier(node: ts.Expression): string | undefined {
  let cur = unwrap(node);
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = unwrap(cur.expression);
  return ts.isIdentifier(cur) ? cur.text : undefined;
}

/** `it(…)`, `describe.each(…)(…)`, `test.skip(…)` etc.: returns true when `call` is a test/describe block. */
function isTestBlockCall(call: ts.CallExpression): boolean {
  let callee: ts.Expression = unwrap(call.expression);
  while (true) {
    if (ts.isIdentifier(callee)) return TEST_BLOCK_NAMES.has(callee.text);
    if (ts.isPropertyAccessExpression(callee)) callee = unwrap(callee.expression);
    else if (ts.isCallExpression(callee)) callee = unwrap(callee.expression);
    else return false;
  }
}

function isTestCallback(fn: ts.Node): boolean {
  return (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !!fn.parent && ts.isCallExpression(fn.parent) && isTestBlockCall(fn.parent);
}

function isPinCall(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return PIN_FUNCTIONS.has(callee.text);
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "vi") {
    if (callee.name.text === "setSystemTime") return true;
    if (callee.name.text === "useFakeTimers") {
      const opts = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
      return !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "now");
    }
  }
  return false;
}

/** Does `scope` contain a pin, not counting the bodies of nested test/describe callbacks (siblings)? */
function scopeHasPin(scope: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== scope && isTestCallback(node)) return;
    if (ts.isCallExpression(node) && isPinCall(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

function fileHasAnyPin(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && isPinCall(node)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function isPinned(call: ts.CallExpression, sf: ts.SourceFile): boolean {
  let insideTest = false;
  for (let a: ts.Node | undefined = call.parent; a; a = a.parent) {
    if (ts.isSourceFile(a) || isTestCallback(a)) {
      if (isTestCallback(a)) insideTest = true;
      if (scopeHasPin(a)) return true;
    }
  }
  return insideTest ? false : fileHasAnyPin(sf);
}

function hasAllowMarker(call: ts.CallExpression, sf: ts.SourceFile): boolean {
  const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line;
  const lines = sf.text.split("\n");
  return [lines[line], lines[line - 1]].some((l) => l !== undefined && l.includes(ALLOW_MARKER));
}

/** All unpinned public calls with a fixed `now` in one source text. */
export function findUnpinnedFixedNow(file: string, text: string): ClockFinding[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const findings: ClockFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const [fnRef, args] = node.arguments;
      if (
        ts.isPropertyAccessExpression(callee) &&
        PUBLIC_CALL_METHODS.has(callee.name.text) &&
        fnRef &&
        rootIdentifier(fnRef) === "api" &&
        args &&
        ts.isObjectLiteralExpression(unwrap(args))
      ) {
        for (const prop of (unwrap(args) as ts.ObjectLiteralExpression).properties) {
          const value =
            ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "now"
              ? prop.initializer
              : ts.isShorthandPropertyAssignment(prop) && prop.name.text === "now"
                ? prop.name
                : undefined;
          if (value && isFixedTime(value) && !isPinned(node, sf) && !hasAllowMarker(node, sf)) {
            findings.push({
              file,
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              text: node.getText(sf).replace(/\s+/g, " ").slice(0, 160),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function collectedTestFiles(): string[] {
  const out: string[] = [];
  for (const root of ["convex", "src"]) {
    for (const rel of readdirSync(path.join(REPO_ROOT, root), { recursive: true, encoding: "utf8" })) {
      const posix = path.posix.join(root, rel.split(path.sep).join("/"));
      if (posix.includes("/node_modules/") || posix.includes("/_generated/")) continue;
      if (/\.test\.tsx?$/.test(posix)) out.push(posix);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------

describe("clock-pin lint (D138 recurrence guard)", () => {
  it("no collected test passes an unpinned fixed `now` to a public function", () => {
    const files = collectedTestFiles();
    expect(files.length).toBeGreaterThan(60);
    const findings = files.flatMap((f) => findUnpinnedFixedNow(f, readFileSync(path.join(REPO_ROOT, f), "utf8")));
    expect(
      findings.map((f) => `${f.file}:${f.line}: ${f.text}`),
      "pin the clock (pinClock / pinClockEach from convex/test.setup.ts) or derive `now` from Date.now()",
    ).toEqual([]);
  });

  it("sees the existing pinned fixed-now calls (the scan is not vacuous)", () => {
    // These files pass fixed `now` values to public queries under a pin today;
    // with the pin removed each must be flagged.
    for (const f of ["convex/tracking.test.ts", "convex/watches.test.ts", "convex/budget.test.ts", "convex/dashboard.test.ts", "convex/offers.test.ts"]) {
      const text = readFileSync(path.join(REPO_ROOT, f), "utf8");
      expect(findUnpinnedFixedNow(f, text), f).toEqual([]);
      const unpinned = text.replace(/vi\.setSystemTime\(/g, "void (").replace(/\bpinClock(Each)?\(/g, "void (");
      expect(findUnpinnedFixedNow(f, unpinned).length, f).toBeGreaterThan(0);
    }
  });
});

describe("clock-pin lint: synthetic cases", () => {
  const scan = (body: string) => findUnpinnedFixedNow("synthetic.test.ts", body).length;

  it("flags the pre-fix D138 shape (fixed NOW inside the test, no pin)", () => {
    expect(
      scan(`
        it("read budget", async () => {
          const NOW = Date.UTC(2026, 8, 21, 12);
          await t.run(async (ctx) => {
            result = await ctx.runQuery(api.tracking.overview, { now: NOW });
          });
        });`),
    ).toBe(1);
  });

  it("accepts the fixed D138 shape (describe-level Date pin)", () => {
    expect(
      scan(`
        describe("read budget", () => {
          const NOW = Date.UTC(2026, 8, 21, 12);
          beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
          afterEach(() => vi.useRealTimers());
          it("x", async () => { await ctx.runQuery(api.tracking.overview, { now: NOW }); });
        });`),
    ).toBe(0);
  });

  it("accepts file-level pins, pinClock in the test, pinClockEach in the describe, and useFakeTimers({ now })", () => {
    expect(scan(`const T0 = Date.UTC(2026, 8, 20); beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
      it("a", async () => { await as.query(api.watches.list, { now: T0 + 4 * DAY }); });`)).toBe(0);
    expect(scan(`it("a", async () => { const N = Date.UTC(2026, 0, 1); const restore = pinClock(N); await as.query(api.budget.status, { now: N }); restore(); });`)).toBe(0);
    expect(scan(`describe("d", () => { const N = Date.UTC(2026, 0, 1); pinClockEach(N); it("a", async () => { await as.query(api.budget.status, { now: N }); }); });`)).toBe(0);
    expect(scan(`const T0 = 1_758_456_000_000; beforeEach(() => vi.useFakeTimers({ now: T0 })); it("a", async () => { await as.query(api.budget.status, { now: T0 }); });`)).toBe(0);
  });

  it("does not let a pin in a sibling test cover another test", () => {
    expect(
      scan(`
        const N = Date.UTC(2026, 0, 1);
        it("pinned", () => { vi.setSystemTime(N); });
        it("unpinned", async () => { await as.query(api.budget.status, { now: N }); });`),
    ).toBe(1);
  });

  it("recognises every fixed-time form, through consts, arithmetic and the shorthand", () => {
    const inTest = (expr: string, pre = "") => scan(`it("x", async () => { ${pre} await t.query(api.a.b, { now: ${expr} }); });`);
    expect(inTest("Date.UTC(2026, 8, 21)")).toBe(1);
    expect(inTest(`Date.parse("2026-09-21T12:00:00Z")`)).toBe(1);
    expect(inTest(`new Date("2026-09-21T12:00:00Z").getTime()`)).toBe(1);
    expect(inTest(`+new Date(2026, 8, 21)`)).toBe(1);
    expect(inTest("1_758_456_000_000")).toBe(1);
    expect(inTest("T0 + 5 * DAY", "const T0 = Date.UTC(2026, 8, 20); const DAY = 86_400_000;")).toBe(1);
    expect(scan(`it("x", async () => { const now = Date.UTC(2026, 8, 21); await as.query(api.a.b, { now }); });`)).toBe(1);
  });

  it("ignores clock-relative values, non-instants, destructured values, internal functions and plain helpers", () => {
    const inTest = (expr: string, pre = "") => scan(`it("x", async () => { ${pre} await t.query(api.a.b, { now: ${expr} }); });`);
    expect(inTest("Date.now()")).toBe(0);
    expect(inTest("Date.now() - 2 * DAY")).toBe(0);
    expect(inTest("Number.NaN")).toBe(0);
    expect(inTest("-1")).toBe(0);
    expect(inTest("86_400_000")).toBe(0);
    expect(inTest(`Date.parse(input)`)).toBe(0);
    expect(scan(`it("x", async () => { const { now } = await seed(t); await as.query(api.a.b, { now }); });`)).toBe(0);
    expect(scan(`async function f(now: number) { await as.query(api.a.b, { now }); }`)).toBe(0);
    expect(scan(`it("x", async () => { await t.query(internal.a.b, { now: Date.UTC(2026, 0, 1) }); });`)).toBe(0);
    expect(scan(`it("x", () => { verdict({ now: Date.UTC(2026, 0, 1) }); });`)).toBe(0);
  });

  it("honours the escape hatch on the call line or the line above", () => {
    expect(
      scan(`it("x", async () => {
        // clock-lint: allow a 2020 instant is outside the ±24 h window on any date after 2020-01-02
        await expect(as.query(api.a.b, { now: Date.UTC(2020, 0, 1) })).rejects.toThrow();
      });`),
    ).toBe(0);
  });
});
