namespace Ims.Domain.Auditing;

/// <summary>
/// One row change, written by PostgreSQL triggers inside the same transaction as the change itself — never by
/// application code. Append-only: the database rejects updates, deletes and inserts that do not come from the trigger.
/// </summary>
public sealed class AuditLogEntry
{
    private AuditLogEntry()
    {
        DatabaseUser = null!;
        Operation = null!;
        TableName = null!;
        NewValues = null!;
        EntityId = null!;
    }

    public long Id { get; private set; }

    public DateTimeOffset OccurredAt { get; private set; }

    public AuditActorType ActorType { get; private set; }

    public Guid? ActorId { get; private set; }

    public string DatabaseUser { get; private set; }

    /// <summary>Groups the rows changed by one transaction (one business action).</summary>
    public long TransactionId { get; private set; }

    /// <summary><c>INSERT</c> or <c>UPDATE</c> (deletes are impossible).</summary>
    public string Operation { get; private set; }

    public string TableName { get; private set; }

    /// <summary>Primary key of the changed row, as text (uuid, code or number).</summary>
    public string EntityId { get; private set; }

    /// <summary>JSON of the changed columns before the update; <c>null</c> for inserts.</summary>
    public string? OldValues { get; private set; }

    /// <summary>JSON of the inserted row, or of the changed columns after the update.</summary>
    public string NewValues { get; private set; }
}
