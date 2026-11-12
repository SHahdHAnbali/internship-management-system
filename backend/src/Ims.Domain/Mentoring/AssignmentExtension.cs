using Ims.Domain.Common;

namespace Ims.Domain.Mentoring;

/// <summary>
/// One extension of a training (PDF §4 «تمديد … مع حفظ السبب»; AD-63 L2, NEW-35): the assignment, its planned end date
/// before and after, the mandatory reason, the HR user and the time. Created by <see cref="Assignment.Extend"/>, which
/// moves the assignment's end date in the same change. Insert-only and never deleted, so every extension and its reason
/// stay on record.
/// </summary>
public sealed class AssignmentExtension : Entity
{
    public const int ReasonMaxLength = 2000;

    private AssignmentExtension()
    {
        Reason = null!;
    }

    public Guid AssignmentId { get; private set; }

    public DateOnly PreviousEndDate { get; private set; }

    public DateOnly NewEndDate { get; private set; }

    public string Reason { get; private set; }

    public Guid ExtendedById { get; private set; }

    public DateTimeOffset ExtendedAt { get; private set; }

    internal static AssignmentExtension Record(
        Guid assignmentId,
        DateOnly previousEndDate,
        DateOnly newEndDate,
        string reason,
        Guid extendedById,
        DateTimeOffset now) => new()
        {
            AssignmentId = assignmentId,
            PreviousEndDate = previousEndDate,
            NewEndDate = newEndDate,
            Reason = Guard.Required(reason, "Extension reason", ReasonMaxLength),
            ExtendedById = Guard.NotEmpty(extendedById, "HR user"),
            ExtendedAt = Guard.Utc(now),
        };
}
