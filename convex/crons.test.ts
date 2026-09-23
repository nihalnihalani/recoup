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

describe("crons — M29 wiring", () => {
  it("runs the deadline sweep hourly and the evidence extraction retry every 15 minutes, with no arguments", () => {
    const jobs = (crons as unknown as { crons: Record<string, { name: string; args: unknown[]; schedule: Record<string, unknown> }> }).crons;
    expect(jobs["deadline sweep"]).toMatchObject({ name: "deadlines:sweep", args: [{}], schedule: { type: "interval", hours: 1 } });
    expect(jobs["evidence extraction retry"]).toMatchObject({ name: "evidence:retryStalledExtractions", args: [{}], schedule: { type: "interval", minutes: 15 } });
  });
});

describe("crons — P02-OW-2 wiring", () => {
  it("sweeps stalled claim emails hourly, beside the alert mail sweep", () => {
    const jobs = (crons as unknown as { crons: Record<string, { name: string; args: unknown[]; schedule: Record<string, unknown> }> }).crons;
    expect(jobs["claim email sweep"]).toMatchObject({ name: "drafts:sweepStalled", args: [{}], schedule: { type: "interval", hours: 1 } });
    expect(jobs["mail sweep"]).toMatchObject({ name: "notify:sweepStalled", args: [{}], schedule: { type: "interval", hours: 1 } });
  });
});
