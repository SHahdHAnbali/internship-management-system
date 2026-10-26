namespace Ims.Domain.Common;

/// <summary>
/// Base type for all persisted entities. Records are never hard-deleted (see docs/architecture.md),
/// so there is no delete flag here: cancellation/withdrawal is modelled as a status on each entity.
/// Ids are generated client-side (time-ordered UUID v7) so aggregates can link children before saving.
/// </summary>
public abstract class Entity
{
    public Guid Id { get; protected init; } = Guid.CreateVersion7();
}
