import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("price watch", { hours: 6 }, internal.priceWatch.runAll, {});

// TODO(lead): the integrations lane (sonnet-integrations) is writing
// convex/inbound.ts concurrently and `internal.inbound.retryFailed` did not
// exist yet as of this commit. Uncomment once it lands.
// crons.interval("retry failed inbound", { hours: 1 }, internal.inbound.retryFailed, {});

export default crons;
