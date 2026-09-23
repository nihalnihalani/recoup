// @vitest-environment happy-dom
/**
 * P09-SK-2 regression: on origin/main, the still-signed-in `DeletionInProgress` screen always titles a `deleted`
 * tombstone "Account deleted", even when the remote-inbox delete failed or the mail-component purge never finished
 * (`deletionHeadline` does not exist on base at all). A user whose deletion actually hit one of those failures saw
 * the same clean "removed" claim as a user whose deletion went perfectly. This test renders `Settings` (which
 * early-returns `DeletionInProgress` once `deletionStatus` is `deleting`/`deleted`) and checks the headline is
 * truthful about a failed remote-inbox delete.
 */
import { getFunctionName, type FunctionReference } from "convex/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "../test/dom";
import Settings from "./Settings";

let deletionStatus: unknown = null;

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: vi.fn() }) }));
vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">) => {
    if (getFunctionName(ref) === "account:deletionStatus") return deletionStatus;
    return undefined;
  },
  useMutation: () => vi.fn(async () => null),
  useAction: () => vi.fn(async () => null),
  useConvex: () => ({ query: vi.fn() }),
}));

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
}

describe("Settings deletion-in-progress screen (P09-SK-2)", () => {
  it("titles a clean deletion 'Account deleted'", () => {
    deletionStatus = { status: "deleted", inboxDeleted: true, mailDataPurged: true, attempts: 1 };
    renderSettings();
    expect(screen.getByRole("heading", { name: "Account deleted" })).toBeTruthy();
  });

  it("does NOT claim a clean 'Account deleted' when the remote inbox delete failed", () => {
    deletionStatus = { status: "deleted", inboxDeleted: false, mailDataPurged: true, attempts: 5 };
    renderSettings();
    expect(screen.queryByRole("heading", { name: "Account deleted" })).toBeNull();
    expect(screen.getByText(/mail clean-up incomplete/i)).toBeTruthy();
    expect(screen.getByText(/mail provider failed/i)).toBeTruthy();
  });

  it("does NOT claim a clean 'Account deleted' when the stored-mail purge is incomplete", () => {
    deletionStatus = { status: "deleted", inboxDeleted: true, mailDataPurged: false, attempts: 1 };
    renderSettings();
    expect(screen.queryByRole("heading", { name: "Account deleted" })).toBeNull();
    expect(screen.getByText(/did not finish/i)).toBeTruthy();
  });

  it("shows 'Deletion in progress' while still deleting, not a finished claim", () => {
    deletionStatus = { status: "deleting", inboxDeleted: false, mailDataPurged: false, attempts: 0 };
    renderSettings();
    expect(screen.getByRole("heading", { name: "Deletion in progress" })).toBeTruthy();
  });
});
