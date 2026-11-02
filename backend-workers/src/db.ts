import { Client, type QueryResultRow } from 'pg';
import { ConcurrencyError } from './domain/errors';

/** Who is acting, recorded by the PostgreSQL audit triggers (`audit_logs.actor_type`, `actor_id`). */
export interface AuditActor {
  type: 'Anonymous' | 'Staff' | 'Trainee' | 'System';
  id: string | null;
}

export interface Queryable {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

/**
 * One PostgreSQL connection per request (Workers cannot share sockets between requests), opened on first use and
 * closed when the response is done. The schema, its constraints, no-delete triggers and audit triggers are owned by the
 * EF Core migrations in ../backend; this API never changes them.
 */
export class Database implements Queryable {
  readonly #connectionString: string;
  #client: Promise<Client> | null = null;
  #closing = false;

  constructor(connectionString: string) {
    this.#connectionString = connectionString;
  }

  async query<T extends QueryResultRow>(text: string, params: unknown[] = []) {
    const client = await this.#connect();
    const result = await client.query<T>(text, params);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  /**
   * Runs `work` in a transaction whose writes are audited with `actor` (the equivalent of one EF Core SaveChanges).
   * The actor is set with `set_config(…, true)`, which is scoped to the transaction, so it is also correct behind a
   * transaction-mode pooler (Neon's pooler, Hyperdrive). The C# API sets the same settings per connection.
   */
  async transaction<T>(actor: AuditActor, work: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#connect();
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('ims.actor_type', $1, true), set_config('ims.actor_id', $2, true)", [
        actor.type,
        actor.id ?? '',
      ]);
      const result = await work(this);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.#client) return;
    const pending = this.#client;
    this.#client = null;
    this.#closing = true;
    try {
      await (await pending).end();
    } catch {
      // the connection failed or is already closed
    }
  }

  #connect(): Promise<Client> {
    this.#client ??= (async () => {
      // Npgsql's defaults in the C# API: 15 s to connect, 30 s per command.
      const client = new Client({
        connectionString: this.#connectionString,
        connectionTimeoutMillis: 15_000,
        query_timeout: 30_000,
      });
      // pg-cloudflare reports its own socket shutdown as an error after `end()`; anything else is logged. (Without a
      // listener, pg would turn these events into unhandled rejections.)
      client.on('error', (error) => {
        if (!this.#closing) {
          console.error(
            JSON.stringify({ level: 'error', message: 'PostgreSQL connection error', error: error.message }),
          );
        }
      });
      await client.connect();
      return client;
    })();
    return this.#client;
  }
}

/** An UPDATE guarded by the row's xmin (EF Core's concurrency token): no row means someone else changed it first. */
export async function updateOrConflict(tx: Queryable, sql: string, params: unknown[]): Promise<void> {
  const { rowCount } = await tx.query(sql, params);
  if (rowCount === 0) throw new ConcurrencyError();
}

/** The SQLSTATE of a PostgreSQL error (e.g. 23505 unique_violation, 23001 restrict_violation). */
export function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
