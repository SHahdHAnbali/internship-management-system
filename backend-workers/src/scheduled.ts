import { productionDependencies } from './app';
import { loadSettings, type Bindings } from './config';
import type { Dependencies } from './context';
import { Database } from './db';
import { deliverEventEmails, trainingTransferredEmails } from './features/notifications/eventEmails';
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
 *
 * E-mail (AD-65): the incoming mentor of each transfer **this run** executed gets one e-mail, best effort, after its
 * transaction committed (the same delivery as every event e-mail: no delivery record, no retry). A decision executed by
 * a concurrent run, or whose commit failed, is not this run's, so no run e-mails a transfer twice.
 */
export function createScheduledHandler(
  dependencies: Pick<Dependencies, 'now' | 'emailSender'> = productionDependencies,
) {
  return (controller: ScheduledController, env: Bindings, ctx: ExecutionContext): void => {
    ctx.waitUntil(runScheduledJobs(controller, env, dependencies, ctx));
  };
}

async function runScheduledJobs(
  controller: ScheduledController,
  env: Bindings,
  dependencies: Pick<Dependencies, 'now' | 'emailSender'>,
  ctx: ExecutionContext,
): Promise<void> {
  const settings = loadSettings(env);
  const db = new Database(settings.databaseUrl);
  try {
    const { summary, executedTransferIds } = await executeDueTransfers(db, dependencies.now());
    console.log(
      JSON.stringify({ level: 'info', message: 'Scheduled transfers run', cron: controller.cron, ...summary }),
    );
    // Loaded and rendered here, before the connection closes; each send then runs in waitUntil. Never throws.
    await deliverEventEmails(
      {
        settings,
        db,
        sender: () => dependencies.emailSender(settings),
        waitUntil: (promise) => ctx.waitUntil(promise),
      },
      (q) => trainingTransferredEmails(q, executedTransferIds),
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
