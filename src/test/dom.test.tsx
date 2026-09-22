// @vitest-environment happy-dom
/**
 * M08 / QA-13: proves `src/**\/*.test.tsx` files are collected by `npm test`
 * and `npm run test:ci`, run in a DOM (happy-dom), render React 19 through
 * React Testing Library, and are cleaned up between tests. Deliberately
 * trivial and independent of any app component, so product changes can
 * never break it; real component tests (M15) follow the same header.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "./dom";

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((n) => n + 1)}>
      {label}: {count}
    </button>
  );
}

describe("DOM test environment (M08, QA-13)", () => {
  it("runs in happy-dom, not the edge-runtime default", () => {
    expect(typeof document).toBe("object");
    expect(navigator.userAgent).toContain("HappyDOM");
  });

  it("renders a React component and applies a state update from an event", () => {
    render(<Counter label="Clicks" />);
    fireEvent.click(screen.getByRole("button", { name: "Clicks: 0" }));
    expect(screen.getByRole("button", { name: "Clicks: 1" })).toBeDefined();
  });

  // Runs after the previous test (vitest runs a file's tests in order): the
  // helper's afterEach(cleanup) must have unmounted the Counter.
  it("unmounts the previous test's tree", () => {
    expect(document.body.innerHTML).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
