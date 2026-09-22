/**
 * M14: the two new daily sweeps are registered against the right functions.
 * The sweeps' behaviour is covered in retention.test.ts and
 * lib/privacyFacts.test.ts; this only guards the wiring. A sweep that is
 * never scheduled would leave the Privacy page's promises unenforced.
 */
import { describe, expect, it } from "vitest";
import crons from "./crons";

describe("crons — M14 retention wiring", () => {
  it("runs the recovery retention sweep and the orphan blob sweep once a day, with no arguments", () => {
    const jobs = (crons as unknown as { crons: Record<string, { name: string; args: unknown[]; schedule: Record<string, unknown> }> }).crons;
    expect(jobs["recovery retention sweep"]).toMatchObject({ name: "retention:sweepRecovery", args: [{}], schedule: { type: "interval", hours: 24 } });
    expect(jobs["orphan blob sweep"]).toMatchObject({ name: "retention:sweepOrphanBlobs", args: [{}], schedule: { type: "interval", hours: 24 } });
    // The D75 sweep is still there, unchanged.
    expect(jobs["retention sweep"]).toMatchObject({ name: "retention:sweep", schedule: { type: "interval", hours: 24 } });
  });
});
