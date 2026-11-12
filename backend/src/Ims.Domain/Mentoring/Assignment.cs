using Ims.Domain.Common;

namespace Ims.Domain.Mentoring;

/// <summary>
/// The approved link between an accepted application and the employee who mentors it (PDF §3, §8: application,
/// employee, start date, end date, status, end or transfer reason). Created by HR's approval of a mentor request.
/// Statuses (owner decision 2026-10-29): Active, Completed, EndedEarly, Transferred, Withdrawn. The Workers API ends a
/// training (AD-63 Phase 1) and extends it (<see cref="Extend"/>, NEW-35). Never deleted.
/// </summary>
public sealed class Assignment : Entity
{
    public const int EndReasonMaxLength = 2000;

    private Assignment()
    {
    }

    public Guid ApplicationId { get; private set; }

    public Guid EmployeeId { get; private set; }

    /// <summary>The approved request this assignment came from.</summary>
    public Guid? MentorRequestId { get; private set; }

    public DateOnly StartDate { get; private set; }

    public DateOnly EndDate { get; private set; }

    public AssignmentStatus Status { get; private set; }

    /// <summary>Why it ended or was transferred (PDF §8), when that happens.</summary>
    public string? EndReason { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    internal static Assignment Start(
        Guid applicationId,
        Guid employeeId,
        Guid mentorRequestId,
        DateOnly startDate,
        DateOnly endDate,
        DateTimeOffset now)
    {
        if (endDate < startDate)
        {
            throw new DomainException("assignment.invalid_period", "The training must end on or after its start date.");
        }

        return new Assignment
        {
            ApplicationId = Guard.NotEmpty(applicationId, "Application"),
            EmployeeId = Guard.NotEmpty(employeeId, "Employee"),
            MentorRequestId = Guard.NotEmpty(mentorRequestId, "Mentor request"),
            StartDate = startDate,
            EndDate = endDate,
            Status = AssignmentStatus.Active,
            CreatedAt = Guard.Utc(now),
        };
    }

    /// <summary>
    /// Extends an Active training (AD-63 L2, NEW-35): the new planned end date must be strictly later than the current
    /// one (also when the current one has already passed), the reason is mandatory, and there is no limit on the number
    /// of extensions. Returns the extension record to save with this change.
    /// </summary>
    public AssignmentExtension Extend(DateOnly newEndDate, string reason, Guid hrId, DateTimeOffset now)
    {
        if (Status != AssignmentStatus.Active)
        {
            throw new DomainException("assignment.invalid_status", "Only an active training can be extended.");
        }

        if (newEndDate <= EndDate)
        {
            throw new DomainException(
                "assignment.extension_not_later",
                "The new end date must be later than the current end date.");
        }

        var extension = AssignmentExtension.Record(Id, EndDate, newEndDate, reason, hrId, now);
        EndDate = newEndDate;
        return extension;
    }
}

public enum AssignmentStatus
{
    Active,
    Completed,
    EndedEarly,
    Transferred,
    Withdrawn,
}
