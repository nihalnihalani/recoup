/**
 * DOM test helpers for `src/**\/*.test.tsx` component tests (M08, QA-13).
 *
 * Usage — the FIRST line of the test file must select the DOM environment
 * (the suite default is `edge-runtime`, which has no `document`):
 *
 *   // @vitest-environment happy-dom
 *   import { fireEvent, render, screen } from "../test/dom";
 *
 * Import render/screen/fireEvent/etc. from HERE rather than from
 * `@testing-library/react` directly. React Testing Library only registers
 * its automatic `cleanup()` and sets `IS_REACT_ACT_ENVIRONMENT` when the test
 * runner exposes `afterEach`/`beforeAll` as globals, and this repo does not
 * enable vitest globals (they would leak into every Convex test). Without
 * the hooks below, a rendered tree survives into the next test in the same
 * file, and React warns that updates are not wrapped in act(...).
 */
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";

type ActEnvironmentGlobal = { IS_REACT_ACT_ENVIRONMENT?: boolean };

let previousActEnvironment: boolean | undefined;

beforeAll(() => {
  const g = globalThis as ActEnvironmentGlobal;
  previousActEnvironment = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  (globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

export * from "@testing-library/react";
