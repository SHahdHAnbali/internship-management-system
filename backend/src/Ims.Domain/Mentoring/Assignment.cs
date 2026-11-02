using Ims.Domain.Common;

namespace Ims.Domain.Mentoring;

/// <summary>
/// The approved link between an accepted application and the employee who mentors it (PDF §3, §8: application,
/// employee, start date, end date, status, end or transfer reason). Created by HR's approval of a mentor request.
/// Statuses (owner decision 2026-10-29): Active, Completed, EndedEarly, Transferred, Withdrawn; only Active is reached
/// so far, the others belong to the running-training features (PDF §4) that are not built yet. Never deleted.
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
}

public enum AssignmentStatus
{
    Active,
    Completed,
    EndedEarly,
    Transferred,
    Withdrawn,
}
