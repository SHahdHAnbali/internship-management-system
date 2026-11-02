using Ims.Domain.Common;

namespace Ims.Domain.Mentoring;

/// <summary>
/// An employee's request to mentor an accepted trainee ("I want to train them", PDF §3, §4, §8: employee, application,
/// note, status Pending / Approved / Rejected). It waits for HR: approval creates the <see cref="Assignment"/> with the
/// start and end dates HR sets. Never deleted.
/// </summary>
public sealed class MentorRequest : Entity
{
    public const int NoteMaxLength = 2000;

    private MentorRequest()
    {
        Note = null!;
    }

    public Guid EmployeeId { get; private set; }

    public Guid ApplicationId { get; private set; }

    /// <summary>What the employee intends to work on with the trainee.</summary>
    public string Note { get; private set; }

    public MentorRequestStatus Status { get; private set; }

    public DateTimeOffset RequestedAt { get; private set; }

    public DateTimeOffset? DecidedAt { get; private set; }

    /// <summary>The HR member who approved or rejected it.</summary>
    public Guid? DecidedById { get; private set; }

    public static MentorRequest Create(Guid employeeId, Guid applicationId, string note, DateTimeOffset now) => new()
    {
        EmployeeId = Guard.NotEmpty(employeeId, "Employee"),
        ApplicationId = Guard.NotEmpty(applicationId, "Application"),
        Note = Guard.Required(note, "Note", NoteMaxLength),
        Status = MentorRequestStatus.Pending,
        RequestedAt = Guard.Utc(now),
    };

    /// <summary>HR approves after coordination and sets the training period: the assignment starts.</summary>
    public Assignment Approve(Guid hrId, DateOnly startDate, DateOnly endDate, DateTimeOffset now)
    {
        if (Status != MentorRequestStatus.Pending)
        {
            throw new DomainException("mentor_request.invalid_status", "The request has already been decided.");
        }

        var assignment = Assignment.Start(ApplicationId, EmployeeId, Id, startDate, endDate, now); // validates the period first
        Decide(MentorRequestStatus.Approved, hrId, now);
        return assignment;
    }

    public void Reject(Guid hrId, DateTimeOffset now) => Decide(MentorRequestStatus.Rejected, hrId, now);

    private void Decide(MentorRequestStatus decision, Guid hrId, DateTimeOffset now)
    {
        if (Status != MentorRequestStatus.Pending)
        {
            throw new DomainException("mentor_request.invalid_status", "The request has already been decided.");
        }

        Status = decision;
        DecidedById = Guard.NotEmpty(hrId, "HR");
        DecidedAt = Guard.Utc(now);
    }
}

public enum MentorRequestStatus
{
    Pending,
    Approved,
    Rejected,
}
