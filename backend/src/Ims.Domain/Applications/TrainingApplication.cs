using Ims.Domain.Common;

namespace Ims.Domain.Applications;

/// <summary>
/// A trainee's training application (PDF §3, §4, §8: trainee, field, status, requested period, mandatory for the
/// university, attachments, rejection reason; the form also asks for the number of hours). Lifecycle (owner decision
/// 2026-10-29): Submitted → UnderReview → Accepted / Rejected. HR moves it to UnderReview explicitly and may decide from
/// Submitted or UnderReview; Accepted and Rejected are final. Never deleted: a rejected application stays on record.
/// </summary>
public sealed class TrainingApplication : Entity
{
    public const int RejectionReasonMaxLength = 2000;

    private TrainingApplication()
    {
    }

    public Guid TraineeId { get; private set; }

    public Guid FieldId { get; private set; }

    public ApplicationStatus Status { get; private set; }

    /// <summary>The trainee's available period (PDF §4), first and last day.</summary>
    public DateOnly AvailableFrom { get; private set; }

    public DateOnly AvailableTo { get; private set; }

    /// <summary>The number of training hours (PDF §4).</summary>
    public int Hours { get; private set; }

    /// <summary>Whether the training is mandatory for the trainee's university (PDF §4).</summary>
    public bool MandatoryForUniversity { get; private set; }

    public DateTimeOffset SubmittedAt { get; private set; }

    public DateTimeOffset? DecidedAt { get; private set; }

    /// <summary>The HR member who accepted or rejected it.</summary>
    public Guid? DecidedById { get; private set; }

    public string? RejectionReason { get; private set; }

    public static TrainingApplication Submit(
        Guid traineeId,
        Guid fieldId,
        DateOnly availableFrom,
        DateOnly availableTo,
        int hours,
        bool mandatoryForUniversity,
        DateTimeOffset now)
    {
        if (availableTo < availableFrom)
        {
            throw new DomainException("application.invalid_period", "The available period must end on or after its start.");
        }

        if (hours <= 0)
        {
            throw new DomainException("validation.range", "Hours must be greater than zero.");
        }

        return new TrainingApplication
        {
            TraineeId = Guard.NotEmpty(traineeId, "Trainee"),
            FieldId = Guard.NotEmpty(fieldId, "Field"),
            Status = ApplicationStatus.Submitted,
            AvailableFrom = availableFrom,
            AvailableTo = availableTo,
            Hours = hours,
            MandatoryForUniversity = mandatoryForUniversity,
            SubmittedAt = Guard.Utc(now),
        };
    }

    public void MarkUnderReview()
    {
        if (Status != ApplicationStatus.Submitted)
        {
            throw new DomainException("application.invalid_status", "Only a submitted application can be put under review.");
        }

        Status = ApplicationStatus.UnderReview;
    }

    public void Accept(Guid hrId, DateTimeOffset now) => Decide(ApplicationStatus.Accepted, hrId, null, now);

    public void Reject(Guid hrId, string reason, DateTimeOffset now) =>
        Decide(ApplicationStatus.Rejected, hrId, Guard.Required(reason, "Rejection reason", RejectionReasonMaxLength), now);

    private void Decide(ApplicationStatus decision, Guid hrId, string? reason, DateTimeOffset now)
    {
        if (Status is not (ApplicationStatus.Submitted or ApplicationStatus.UnderReview))
        {
            throw new DomainException("application.invalid_status", "The application has already been decided.");
        }

        Status = decision;
        DecidedById = Guard.NotEmpty(hrId, "HR");
        DecidedAt = Guard.Utc(now);
        RejectionReason = reason;
    }
}

public enum ApplicationStatus
{
    Submitted,
    UnderReview,
    Accepted,
    Rejected,
}
