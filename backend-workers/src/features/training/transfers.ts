import type { AuditActor, Queryable } from '../../db';
import { DomainError, StateConflictError } from '../../domain/errors';
import { calendarDate, transferExecution } from '../../domain/training';
import { uuidV7 } from '../../domain/uuid';

/**
 * Transfer decisions and their execution (AD-65, owner decisions 2026-11-13, revised).
 *
 * The current responsible HR decides a transfer for today (executed at once, in the same transaction) or for a later
 * Asia/Hebron date (`transfer_decisions`, Pending; executed by the scheduled job on that date). A decision is never
 * deleted: it ends Executed (with its `assignment_transfers` link), Cancelled (by the current responsible HR, with a
 * reason) or Void (it can no longer be executed). At most one decision of an application is Pending
 * (`ux_transfer_decisions_application_id`).
 *
 * Locks are always taken in the same order, so concurrent work waits instead of deadlocking: the application (FOR SHARE,
 * when the responsible HR is checked), then the outgoing assignment (FOR UPDATE, or the row lock of its UPDATE), then the
 * decision, then the incoming mentor's employee row (FOR SHARE).
 */

export const TRANSFER_DECISION_STATUSES = ['Pending', 'Executed', 'Cancelled', 'Void'] as const;

/** Why a decision was voided (`transfer_decisions.resolution_code`). */
export type TransferVoidCode = 'training_ended' | 'mentor_not_employee' | 'dates_invalid';

/** The audit actor of the scheduled job: the deciding HR stays on the decision and the link (`transferred_by_id`). */
export const SCHEDULER_ACTOR: AuditActor = { type: 'System', id: null };

export interface LockedAssignment {
  id: string;
  application_id: string;
  status: string;
  start_date: string;
  end_date: string;
  employee_id: string;
}

/** The assignment, locked FOR UPDATE until the end of the transaction (null when it does not exist). */
export async function lockAssignment(tx: Queryable, id: string): Promise<LockedAssignment | null> {
  const { rows } = await tx.query<LockedAssignment>(
    `SELECT id, application_id, status, start_date::text, end_date::text, employee_id
       FROM assignments WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

/** Whether the employee holds the Employee role now; their row is locked FOR SHARE so a role change waits. */
export async function holdsEmployeeRole(tx: Queryable, employeeId: string): Promise<boolean> {
  const { rows } = await tx.query<{ role: string }>('SELECT role FROM employees WHERE id = $1 FOR SHARE', [employeeId]);
  return rows[0]?.role === 'Employee';
}

/**
 * Refuses a change to an assignment whose transfer is due (its effective date has come) but not executed yet: between the
 * start of the Asia/Hebron day and the scheduled run, the outgoing mentor's notes and HR's lifecycle changes would
 * otherwise apply to an assignment that ends the day before. Call it after locking the assignment.
 */
export async function assertNoDueTransfer(tx: Queryable, assignmentId: string, now: Date): Promise<void> {
  const { rows } = await tx.query(
    `SELECT 1 FROM transfer_decisions
      WHERE from_assignment_id = $1 AND status = 'Pending' AND effective_date <= $2::date`,
    [assignmentId, calendarDate(now)],
  );
  if (rows.length > 0) {
    throw new StateConflictError(
      'assignment.transfer_due',
      'A transfer of this training takes effect today and is being processed. Try again later.',
    );
  }
}

/**
 * The training ended (Completed, EndedEarly, Withdrawn) before a scheduled transfer's date: the transfer can no longer
 * happen, so its decision is voided in the same transaction (kept, with the reason code).
 */
export async function voidPendingTransfer(tx: Queryable, assignmentId: string, now: Date): Promise<void> {
  await tx.query(
    `UPDATE transfer_decisions SET status = 'Void', resolution_code = 'training_ended', resolved_at = $2
      WHERE from_assignment_id = $1 AND status = 'Pending'`,
    [assignmentId, now],
  );
}

export interface PendingDecision {
  id: string;
  incoming_employee_id: string;
  effective_date: string;
  reason: string;
  decided_by_id: string;
}

/**
 * Executes a Pending decision whose effective date has come, against the locked outgoing assignment: it becomes
 * Transferred (ends the day before the effective date, keeps the reason), the incoming assignment starts on the effective
 * date with the planned end date as it is now, the link records the actual time, and the decision becomes Executed.
 * Returns the incoming assignment's id.
 */
export async function applyTransfer(
  tx: Queryable,
  decision: PendingDecision,
  outgoing: LockedAssignment,
  now: Date,
): Promise<string> {
  const execution = transferExecution(
    { incomingEmployeeId: decision.incoming_employee_id, effectiveDate: decision.effective_date },
    {
      status: outgoing.status,
      startDate: outgoing.start_date,
      plannedEndDate: outgoing.end_date,
      employeeId: outgoing.employee_id,
    },
  );
  const incomingId = uuidV7(now);
  // Close the outgoing assignment first, so the application never has two Active ones (ux_assignments_application_id).
  await tx.query(
    `UPDATE assignments SET status = 'Transferred', end_date = $2, end_reason = $3 WHERE id = $1 AND status = 'Active'`,
    [outgoing.id, execution.outgoingEndDate, decision.reason],
  );
  await tx.query(
    `INSERT INTO assignments (id, application_id, employee_id, mentor_request_id, start_date, end_date, status, created_at)
     VALUES ($1, $2, $3, NULL, $4, $5, 'Active', $6)`,
    [
      incomingId,
      outgoing.application_id,
      decision.incoming_employee_id,
      decision.effective_date,
      execution.plannedEndDate,
      now,
    ],
  );
  await tx.query(
    `INSERT INTO assignment_transfers
       (id, decision_id, from_assignment_id, to_assignment_id, transferred_by_id, transferred_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidV7(now), decision.id, outgoing.id, incomingId, decision.decided_by_id, now],
  );
  await tx.query(
    `UPDATE transfer_decisions SET status = 'Executed', resolved_at = $2 WHERE id = $1 AND status = 'Pending'`,
    [decision.id, now],
  );
  return incomingId;
}

/** What one scheduled run did; `failed` decisions stay Pending and are retried by the next run. */
export interface TransferRunSummary {
  due: number;
  executed: number;
  voided: number;
  skipped: number;
  failed: number;
}

/** A database that can run audited transactions (the Worker's `Database`; a test double in the tests). */
export interface TransactionalDatabase extends Queryable {
  transaction<T>(actor: AuditActor, work: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * The scheduled job (AD-65): executes every Pending decision whose effective date is today or earlier in Asia/Hebron,
 * so a run that was missed (an outage) is caught up by the next one, with the decision's own dates. Each decision is
 * handled in its own transaction as the System actor, so one failure neither blocks nor undoes the others; a failed
 * decision stays Pending and is retried by the next run. Idempotent: a decision already resolved (by a concurrent run, a
 * cancellation or a lifecycle change) is skipped, and the unique links prevent any duplicate.
 */
export async function executeDueTransfers(db: TransactionalDatabase, now: Date): Promise<TransferRunSummary> {
  const today = calendarDate(now);
  const { rows: due } = await db.query<{ id: string; from_assignment_id: string }>(
    `SELECT id, from_assignment_id FROM transfer_decisions
      WHERE status = 'Pending' AND effective_date <= $1::date
      ORDER BY effective_date, decided_at, id`,
    [today],
  );
  const summary: TransferRunSummary = { due: due.length, executed: 0, voided: 0, skipped: 0, failed: 0 };
  for (const decision of due) {
    try {
      const outcome = await db.transaction(SCHEDULER_ACTOR, (tx) =>
        executeDecision(tx, decision.id, decision.from_assignment_id, today, now),
      );
      summary[outcome] += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Scheduled transfer failed; it stays pending for the next run',
          decisionId: decision.id,
          error: error instanceof Error ? error.name : 'Error',
          code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined,
        }),
      );
    }
  }
  return summary;
}

async function executeDecision(
  tx: Queryable,
  decisionId: string,
  assignmentId: string,
  today: string,
  now: Date,
): Promise<'executed' | 'voided' | 'skipped'> {
  const outgoing = await lockAssignment(tx, assignmentId);
  const { rows } = await tx.query<PendingDecision & { status: string }>(
    `SELECT id, status, incoming_employee_id, effective_date::text, reason, decided_by_id
       FROM transfer_decisions WHERE id = $1 FOR UPDATE`,
    [decisionId],
  );
  const decision = rows[0];
  if (!outgoing || !decision || decision.status !== 'Pending' || decision.effective_date > today) return 'skipped';

  const voidAs = async (code: TransferVoidCode) => {
    await tx.query(
      `UPDATE transfer_decisions SET status = 'Void', resolution_code = $2, resolved_at = $3
        WHERE id = $1 AND status = 'Pending'`,
      [decisionId, code, now],
    );
    return 'voided' as const;
  };
  if (outgoing.status !== 'Active') return voidAs('training_ended');
  if (!(await holdsEmployeeRole(tx, decision.incoming_employee_id))) return voidAs('mentor_not_employee');
  try {
    await applyTransfer(tx, decision, outgoing, now);
  } catch (error) {
    // The decision's own rules, checked again, no longer hold (not reachable through the API: the planned end date only
    // moves later, and an ended training is handled above). Permanent, so it is voided rather than retried forever.
    if (error instanceof DomainError) return voidAs('dates_invalid');
    throw error;
  }
  return 'executed';
}
