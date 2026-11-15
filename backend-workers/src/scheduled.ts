import { productionDependencies } from './app';
import { loadSettings, type Bindings } from './config';
import type { Dependencies } from './context';
import { Database } from './db';
import { deliverEventEmails, trainingTransferredEmails } from './features/notifications/eventEmails';
import {
  isPendingReminderRun,
  parseActivationCutoff,
  PENDING_REMINDER_CRON,
  remindPendingRequests,
} from './features/notifications/pendingRequestReminders';
import { executeDueTransfers } from './features/training/transfers';

/**
 * The Worker's scheduled jobs (Cron Triggers, wrangler.jsonc `triggers.crons`), told apart by the trigger's cron
 * expression: `5 3,21,22 * * *` executes the due transfer decisions (AD-65, revised); `0 6,7 * * *` is the daily
 * pending-request reminder check (NEW-05, AD-61 items 4–17), which only acts on the run that falls at 09:xx
 * Asia/Hebron (06:00 UTC in summer, 07:00 UTC in winter); the other run of the day does nothing. An unknown cron does
 * nothing. Each job has its own connection and failures, so one never affects the other.
 *
 * Transfers:
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
export const TRANSFER_CRON = '5 3,21,22 * * *';

type ScheduledDependencies = Pick<Dependencies, 'now' | 'emailSender'>;

export function createScheduledHandler(dependencies: ScheduledDependencies = productionDependencies) {
  return (controller: ScheduledController, env: Bindings, ctx: ExecutionContext): void => {
    ctx.waitUntil(runScheduledJobs(controller, env, dependencies, ctx));
  };
}

async function runScheduledJobs(
  controller: ScheduledController,
  env: Bindings,
  dependencies: ScheduledDependencies,
  ctx: ExecutionContext,
): Promise<void> {
  if (controller.cron === TRANSFER_CRON) return runTransfers(controller, env, dependencies, ctx);
  if (controller.cron === PENDING_REMINDER_CRON) return runPendingReminders(controller, env, dependencies);
  console.warn(JSON.stringify({ level: 'warn', message: 'Unknown Cron Trigger; nothing run', cron: controller.cron }));
}

async function runTransfers(
  controller: ScheduledController,
  env: Bindings,
  dependencies: ScheduledDependencies,
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

/**
 * The daily pending-request reminder check (NEW-05). The e-mails are awaited inside this run (it already runs in
 * `waitUntil`), so each outcome is known before it is recorded; no transaction is open while they are sent.
 */
async function runPendingReminders(
  controller: ScheduledController,
  env: Bindings,
  dependencies: ScheduledDependencies,
): Promise<void> {
  const now = dependencies.now();
  if (!isPendingReminderRun(now)) return; // the other UTC hour of the day: not 09:xx Asia/Hebron
  const settings = loadSettings(env);
  if (!settings.eventEmails) {
    // AD-61 item 16: nothing attempted or recorded; the overdue requests are caught up once e-mails are enabled.
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'Pending-request reminders skipped: event e-mails are disabled',
        cron: controller.cron,
      }),
    );
    return;
  }
  const activatedAt = parseActivationCutoff(env.PENDING_REMINDERS_ACTIVATED_AT);
  if (!activatedAt) {
    // AD-61 item 18: without the launch cutoff no request can be told apart from a pre-launch one, so fail closed:
    // no database access, nothing claimed or sent. Set it once (wrangler.jsonc) at the first production activation.
    console.error(
      JSON.stringify({
        level: 'error',
        message:
          'Pending-request reminders skipped: PENDING_REMINDERS_ACTIVATED_AT is missing or invalid (a UTC timestamp such as 2026-11-20T10:15:00Z); nothing was claimed or sent',
        cron: controller.cron,
      }),
    );
    return;
  }
  const db = new Database(settings.databaseUrl);
  try {
    const summary = await remindPendingRequests(db, {
      now,
      eventEmails: settings.eventEmails,
      activatedAt,
      sender: () => dependencies.emailSender(settings),
      siteBaseUrl: settings.trainee.signInLinkBaseUrl,
    });
    console.log(
      JSON.stringify({ level: 'info', message: 'Pending-request reminders run', cron: controller.cron, ...summary }),
    );
  } catch (error) {
    // The settings or the candidates could not be read: nothing was claimed, and the next daily check retries.
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Pending-request reminders run failed',
        cron: controller.cron,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
    );
    throw error;
  } finally {
    await db.close();
  }
}
