import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("price watch", { hours: 6 }, internal.priceWatch.runAll, {});

crons.interval("retry failed inbound", { hours: 1 }, internal.inbound.retryFailed, {});

export default crons;
