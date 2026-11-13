using Ims.Domain.Common;

namespace Ims.Domain.Mentoring;

/// <summary>
/// The approved link between an accepted application and the employee who mentors it (PDF §3, §8: application,
/// employee, start date, end date, status, end or transfer reason). Created by HR's approval of a mentor request.
/// Statuses (owner decision 2026-10-29): Active, Completed, EndedEarly, Transferred, Withdrawn. The Workers API ends a
/// training (AD-63 Phase 1), extends it (<see cref="Extend"/>, NEW-35) and transfers it to another mentor, now or
/// from a later date (<see cref="DecideTransfer"/>, AD-65). Never deleted.
/// </summary>
public sealed class Assignment : Entity
{
    public const int EndReasonMaxLength = 2000;

    private Assignment()
    {
    }

    public Guid ApplicationId { get; private set; }

    public Guid EmployeeId { get; private set; }

    /// <summary>The approved request this assignment came from; none for an assignment created by a transfer.</summary>
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

    /// <summary>
    /// The current responsible HR's decision to transfer this Active training to another mentor (AD-65, owner
    /// 2026-11-13, revised): the effective date (Asia/Hebron) is today (an immediate transfer) or later (a scheduled one),
    /// never earlier, strictly after this assignment's start date and not after its current planned end date; the reason
    /// is mandatory. Nothing changes on this assignment until the decision is executed
    /// (<see cref="TransferDecision.Execute"/>). That the caller is the current responsible HR (AD-64), that the incoming
    /// mentor holds the Employee role now and that no other transfer of the training is pending are checked by the
    /// caller, which reads the roles and the other decisions.
    /// </summary>
    public TransferDecision DecideTransfer(
        Guid incomingEmployeeId,
        DateOnly effectiveDate,
        string reason,
        Guid hrId,
        DateOnly today,
        DateTimeOffset now)
    {
        if (effectiveDate < today)
        {
            throw new DomainException("assignment.transfer_in_past", "The transfer date cannot be in the past.");
        }

        CheckTransfer(incomingEmployeeId, effectiveDate);
        return TransferDecision.Create(this, incomingEmployeeId, effectiveDate, reason, hrId, now);
    }

    /// <summary>
    /// Carries out a transfer decision (AD-65): this assignment becomes <see cref="AssignmentStatus.Transferred"/>, ends
    /// the day before the effective date and keeps the decision's reason; the incoming assignment starts on the effective
    /// date with this assignment's planned end date as it is now (extensions made since the decision included), without a
    /// mentor request.
    /// </summary>
    internal Assignment Transfer(Guid incomingEmployeeId, DateOnly effectiveDate, string reason, DateTimeOffset now)
    {
        CheckTransfer(incomingEmployeeId, effectiveDate);
        var incoming = new Assignment
        {
            ApplicationId = ApplicationId,
            EmployeeId = incomingEmployeeId,
            MentorRequestId = null,
            StartDate = effectiveDate,
            EndDate = EndDate,
            Status = AssignmentStatus.Active,
            CreatedAt = Guard.Utc(now),
        };
        Status = AssignmentStatus.Transferred;
        EndDate = effectiveDate.AddDays(-1);
        EndReason = reason;
        return incoming;
    }

    private void CheckTransfer(Guid incomingEmployeeId, DateOnly effectiveDate)
    {
        if (Status != AssignmentStatus.Active)
        {
            throw new DomainException("assignment.invalid_status", "Only an active training can be transferred.");
        }

        if (Guard.NotEmpty(incomingEmployeeId, "Incoming mentor") == EmployeeId)
        {
            throw new DomainException(
                "assignment.transfer_same_mentor",
                "The incoming mentor must be different from the current mentor.");
        }

        if (effectiveDate <= StartDate)
        {
            throw new DomainException(
                "assignment.transfer_not_after_start",
                "The transfer date must be after the training's start date.");
        }

        if (effectiveDate > EndDate)
        {
            throw new DomainException(
                "assignment.transfer_after_end",
                "The transfer date cannot be after the training's planned end date.");
        }
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
