// @vitest-environment happy-dom
/**
 * F6 regression (fe2 review, P12-W6): BUILD_ID was exported from src/buildInfo.ts but imported nowhere, so the
 * running build was only visible through the served page's own <meta name="recoup-build"> tag and
 * dist/build-info.json -- never from inside the running SPA itself (e.g. for a support screenshot of a crash).
 * The ErrorBoundary fallback now shows it.
 */
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { BUILD_ID } from "../buildInfo";
import { render, screen } from "../test/dom";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("boom");
}

describe("ErrorBoundary: build id (F6)", () => {
  it("shows the running build on the crash fallback", () => {
    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByText(`Build ${BUILD_ID}`)).toBeDefined();
    // Tests are not a Vite build, so this pins the documented "dev" fallback rather than a real git SHA.
    expect(BUILD_ID).toBe("dev");
  });
});
