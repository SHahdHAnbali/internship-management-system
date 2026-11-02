import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { DomainError, NotFoundError } from '../../domain/errors';
import { parseGuid } from '../../domain/uuid';
import { json, statusProblem } from '../../http/problems';
import { routeId, type Route } from '../../http/routes';
import { TYPES_BY_ROLE, type NotificationType } from './notify';

/** How many notifications one page holds (newest first; "load more" asks for the next page). */
const PAGE_SIZE = 20;

/**
 * `/api/notifications`: the signed-in staff member's own in-app notifications, newest first in pages, and marking one
 * read (PDF §8: read or not). Owner decisions 2026-10-31: each role sees only the types addressed to that role, so after
 * a role change the previous role's notifications are hidden (kept in the database) (C2); every notification, read or
 * not, is reachable through "load more" (C3); only HR and Employee have notifications (C4).
 */
function visibleTypes(c: Context<AppEnv>): readonly NotificationType[] | null {
  const role = c.var.user!.role;
  return role === 'HR' || role === 'Employee' ? TYPES_BY_ROLE[role] : null;
}

interface NotificationRow {
  id: string;
  type: NotificationType;
  entity_id: string;
  is_read: boolean;
  created_at: Date;
  application_id: string | null;
  trainee_name: string | null;
  field_name: string | null;
  employee_name: string | null;
}

export const notificationRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/notifications',
    policy: 'authenticated',
    async handle(c) {
      const types = visibleTypes(c);
      if (!types) return statusProblem(403, c.var.traceId, true);
      const userId = c.var.user!.id;

      // Keyset pagination: `before` is the last notification of the previous page. Ordering by (created_at, id) is
      // total and stable, so pages never skip or repeat a notification, and newer ones never shift older pages.
      const beforeParam = c.req.query('before');
      const before = beforeParam === undefined ? null : parseGuid(beforeParam);
      if (beforeParam !== undefined) {
        const { rows: cursor } = before
          ? await c.var.db.query('SELECT 1 FROM notifications WHERE id = $1 AND recipient_id = $2 AND type = ANY($3)', [
              before,
              userId,
              types,
            ])
          : { rows: [] };
        if (cursor.length === 0) throw new DomainError('validation.invalid', 'The page position is not valid.');
      }

      // What the event is about, read from the records themselves (application, or mentor request and its application).
      const { rows } = await c.var.db.query<NotificationRow>(
        `SELECT n.id, n.type, n.entity_id, n.is_read, n.created_at, a.id AS application_id,
                t.full_name AS trainee_name, f.name AS field_name, e.full_name AS employee_name
           FROM notifications n
           LEFT JOIN mentor_requests r ON n.type <> 'ApplicationSubmitted' AND r.id = n.entity_id
           LEFT JOIN employees e ON e.id = r.employee_id
           LEFT JOIN training_applications a
                  ON a.id = CASE WHEN n.type = 'ApplicationSubmitted' THEN n.entity_id ELSE r.application_id END
           LEFT JOIN trainees t ON t.id = a.trainee_id
           LEFT JOIN fields f ON f.id = a.field_id
          WHERE n.recipient_id = $1 AND n.type = ANY($2)
            AND ($3::uuid IS NULL OR (n.created_at, n.id) < (SELECT p.created_at, p.id FROM notifications p WHERE p.id = $3))
          ORDER BY n.created_at DESC, n.id DESC
          LIMIT ${PAGE_SIZE + 1}`,
        [userId, types, before],
      );
      const page = rows.slice(0, PAGE_SIZE);
      const { rows: unread } = await c.var.db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM notifications WHERE recipient_id = $1 AND type = ANY($2) AND NOT is_read',
        [userId, types],
      );
      return json({
        unreadCount: unread[0]!.count,
        hasMore: rows.length > PAGE_SIZE,
        notifications: page.map((n) => ({
          id: n.id,
          type: n.type,
          isRead: n.is_read,
          createdAt: n.created_at,
          applicationId: n.application_id,
          traineeName: n.trainee_name,
          fieldName: n.field_name,
          employeeName: n.employee_name,
        })),
      });
    },
  },
  {
    // Marks one of the caller's own notifications read. Already read: nothing changes (no extra audit row).
    method: 'POST',
    path: '/api/notifications/:id/read',
    policy: 'authenticated',
    async handle(c) {
      const types = visibleTypes(c);
      if (!types) return statusProblem(403, c.var.traceId, true);
      const id = routeId(c);
      const params = [id, c.var.user!.id, types];
      const { rowCount } = await c.var.db.transaction(c.var.actor, (tx) =>
        tx.query(
          'UPDATE notifications SET is_read = true WHERE id = $1 AND recipient_id = $2 AND type = ANY($3) AND NOT is_read',
          params,
        ),
      );
      if (rowCount === 0) {
        const { rows } = await c.var.db.query(
          'SELECT 1 FROM notifications WHERE id = $1 AND recipient_id = $2 AND type = ANY($3)',
          params,
        );
        if (rows.length === 0) throw NotFoundError.for('Notification', id);
      }
      return new Response(null, { status: 204 });
    },
  },
];
