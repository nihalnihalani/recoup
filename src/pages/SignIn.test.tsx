// @vitest-environment happy-dom
/**
 * P09-SK-2 regression: on origin/main, `SignIn.tsx` never reads the `accountDeleted` route state that
 * `Settings.tsx` navigates here with after "Delete my account" (`location.state` is unused, grep finds 0 hits for
 * `accountDeleted`) — a user who just deleted their account lands on a bare, unexplained sign-in screen. This test
 * mounts `SignIn` at a route carrying that state and checks the explanatory banner renders, and that it stays gone
 * on an ordinary sign-in visit.
 */
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "../test/dom";
import SignIn from "./SignIn";

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn: vi.fn(async () => ({ signingIn: false })) }) }));

describe("SignIn post-deletion banner (P09-SK-2)", () => {
  it("explains the account was deleted when routed here with accountDeleted state", () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/signin", state: { accountDeleted: true } }]}>
        <SignIn />
      </MemoryRouter>,
    );
    expect(screen.getByText(/your account is being deleted, and you are signed out/i)).toBeTruthy();
  });

  it("shows no such banner on an ordinary sign-in visit", () => {
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <SignIn />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/your account is being deleted/i)).toBeNull();
  });
});
