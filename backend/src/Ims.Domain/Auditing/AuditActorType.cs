namespace Ims.Domain.Auditing;

/// <summary>Who caused a change. <see cref="Database"/> marks changes made outside the application (e.g. psql).</summary>
public enum AuditActorType
{
    Anonymous,
    Staff,
    Trainee,
    System,
    Database,
}
