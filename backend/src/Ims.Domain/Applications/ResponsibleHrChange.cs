using Ims.Domain.Common;

namespace Ims.Domain.Applications;

/// <summary>
/// An Admin's appointment of a replacement responsible HR for an accepted application (AD-64, owner 2026-11-13). The
/// responsible HR is the HR member who accepted the application (<see cref="TrainingApplication.DecidedById"/>, kept
/// unchanged) until an Admin appoints a replacement; the change with the highest <see cref="Sequence"/> names the
/// current one. Created by <see cref="TrainingApplication.AppointResponsibleHr"/>. Insert-only and never deleted, so the
/// whole history of responsibility stays on record.
/// </summary>
public sealed class ResponsibleHrChange : Entity
{
    private ResponsibleHrChange()
    {
    }

    public Guid ApplicationId { get; private set; }

    /// <summary>1 for the first replacement of the application, then 2, 3, … (unique per application).</summary>
    public int Sequence { get; private set; }

    /// <summary>The HR member appointed as responsible.</summary>
    public Guid HrId { get; private set; }

    /// <summary>The Admin who made the appointment.</summary>
    public Guid ChangedById { get; private set; }

    public DateTimeOffset ChangedAt { get; private set; }

    internal static ResponsibleHrChange Record(
        Guid applicationId,
        int sequence,
        Guid hrId,
        Guid adminId,
        DateTimeOffset now)
    {
        if (sequence < 1)
        {
            throw new DomainException("validation.range", "The change sequence starts at 1.");
        }

        return new ResponsibleHrChange
        {
            ApplicationId = applicationId,
            Sequence = sequence,
            HrId = Guard.NotEmpty(hrId, "HR"),
            ChangedById = Guard.NotEmpty(adminId, "Admin"),
            ChangedAt = Guard.Utc(now),
        };
    }
}
