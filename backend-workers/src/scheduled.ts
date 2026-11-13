import { productionDependencies } from './app';
import { loadSettings, type Bindings } from './config';
import type { Dependencies } from './context';
import { Database } from './db';
import { executeDueTransfers } from './features/training/transfers';

/**
 * The Worker's scheduled jobs (Cron Triggers, wrangler.jsonc `triggers.crons`). The only one so far executes the due
 * transfer decisions (AD-65, revised).
 *
 * Timing: Cron Triggers run in UTC and Asia/Hebron is UTC+2 in winter and UTC+3 in summer, so no single UTC time is
 * "just after midnight" all year. The job runs at 21:05 and 22:05 UTC (one of them is 00:05 Asia/Hebron in each season;
 * the other finds nothing new, or retries), plus 03:05 UTC (05:05 or 06:05 Asia/Hebron) as a catch-up run. Which
 * decisions are due never depends on the run time: every Pending decision dated today or earlier in Asia/Hebron
 * (computed from the clock, daylight saving included) is executed, so a missed run (an outage) is caught up by the next
 * one with the decision's own dates. Between midnight and the run, the gap guards refuse changes to the assignment.
 */
export function createScheduledHandler(dependencies: Pick<Dependencies, 'now'> = productionDependencies) {
  return (controller: ScheduledController, env: Bindings, ctx: ExecutionContext): void => {
    ctx.waitUntil(runScheduledJobs(controller, env, dependencies));
  };
}

async function runScheduledJobs(
  controller: ScheduledController,
  env: Bindings,
  dependencies: Pick<Dependencies, 'now'>,
): Promise<void> {
  const db = new Database(loadSettings(env).databaseUrl);
  try {
    const summary = await executeDueTransfers(db, dependencies.now());
    console.log(
      JSON.stringify({ level: 'info', message: 'Scheduled transfers run', cron: controller.cron, ...summary }),
    );
  } catch (error) {
    // The database was unreachable, for example: nothing was changed, and the next run picks everything up.
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Scheduled transfers run failed',
        cron: controller.cron,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
    );
    throw error;
  } finally {
    await db.close();
  }
}
