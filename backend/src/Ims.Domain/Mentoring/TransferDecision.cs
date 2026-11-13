using Ims.Domain.Common;

namespace Ims.Domain.Mentoring;

/// <summary>
/// The current responsible HR's decision to transfer a training to another mentor from an effective date (AD-65, owner
/// 2026-11-13, revised; PDF §4 «نقل المتدرب لموظف آخر»). A decision for today is executed at once; one for a later date
/// stays <see cref="TransferDecisionStatus.Pending"/> and the outgoing mentor stays responsible until the scheduled job
/// executes it on that date. A decision is never deleted: it ends Executed (the link is an
/// <see cref="AssignmentTransfer"/>), Cancelled by the current responsible HR with a reason, or Void when it can no longer
/// be executed (the training ended, or the incoming mentor no longer holds the Employee role). At most one decision of a
/// training application is Pending at a time.
/// </summary>
public sealed class TransferDecision : Entity
{
    public const int ResolutionCodeMaxLength = 64;

    private TransferDecision()
    {
    }

    public Guid ApplicationId { get; private set; }

    public Guid FromAssignmentId { get; private set; }

    public Guid IncomingEmployeeId { get; private set; }

    /// <summary>The requested date (Asia/Hebron): the incoming assignment starts on it, the outgoing ends the day before.</summary>
    public DateOnly EffectiveDate { get; private set; }

    public string Reason { get; private set; } = string.Empty;

    public Guid DecidedById { get; private set; }

    public DateTimeOffset DecidedAt { get; private set; }

    public TransferDecisionStatus Status { get; private set; }

    /// <summary>When the decision left Pending: the actual execution, cancellation or void time.</summary>
    public DateTimeOffset? ResolvedAt { get; private set; }

    /// <summary>The HR member who cancelled it; none for an execution or an automatic void.</summary>
    public Guid? ResolvedById { get; private set; }

    /// <summary>Why it was voided (<c>training_ended</c>, <c>mentor_not_employee</c>, <c>dates_invalid</c>).</summary>
    public string? ResolutionCode { get; private set; }

    /// <summary>The cancellation reason.</summary>
    public string? ResolutionReason { get; private set; }

    internal static TransferDecision Create(
        Assignment from,
        Guid incomingEmployeeId,
        DateOnly effectiveDate,
        string reason,
        Guid hrId,
        DateTimeOffset now) => new()
        {
            ApplicationId = from.ApplicationId,
            FromAssignmentId = from.Id,
            IncomingEmployeeId = incomingEmployeeId,
            EffectiveDate = effectiveDate,
            Reason = Guard.Required(reason, "Transfer reason", Assignment.EndReasonMaxLength),
            DecidedById = Guard.NotEmpty(hrId, "HR"),
            DecidedAt = Guard.Utc(now),
            Status = TransferDecisionStatus.Pending,
        };

    /// <summary>
    /// Executes the decision on or after its effective date (immediately for today's, else by the scheduled job): the
    /// outgoing assignment is transferred (<see cref="Assignment.Transfer"/>) and the link records the actual time.
    /// Whether the incoming mentor still holds the Employee role is checked by the caller first (else <see cref="Void"/>).
    /// </summary>
    public (Assignment Incoming, AssignmentTransfer Link) Execute(Assignment outgoing, DateOnly today, DateTimeOffset now)
    {
        EnsurePending();
        if (outgoing.Id != FromAssignmentId)
        {
            throw new DomainException("transfer_decision.wrong_assignment", "The decision is for another assignment.");
        }

        if (EffectiveDate > today)
        {
            throw new DomainException("transfer_decision.not_due", "The transfer is not due yet.");
        }

        var incoming = outgoing.Transfer(IncomingEmployeeId, EffectiveDate, Reason, now);
        Status = TransferDecisionStatus.Executed;
        ResolvedAt = Guard.Utc(now);
        return (incoming, AssignmentTransfer.Record(Id, outgoing.Id, incoming.Id, DecidedById, now));
    }

    /// <summary>The current responsible HR cancels a Pending decision, with a mandatory reason; the decision is kept.</summary>
    public void Cancel(Guid hrId, string reason, DateTimeOffset now)
    {
        EnsurePending();
        var cleanReason = Guard.Required(reason, "Cancellation reason", Assignment.EndReasonMaxLength);
        Status = TransferDecisionStatus.Cancelled;
        ResolvedById = Guard.NotEmpty(hrId, "HR");
        ResolutionReason = cleanReason;
        ResolvedAt = Guard.Utc(now);
    }

    /// <summary>The decision can no longer be executed; it is kept with the reason code.</summary>
    public void Void(string code, DateTimeOffset now)
    {
        EnsurePending();
        ResolutionCode = Guard.Required(code, "Void reason", ResolutionCodeMaxLength);
        Status = TransferDecisionStatus.Void;
        ResolvedAt = Guard.Utc(now);
    }

    private void EnsurePending()
    {
        if (Status != TransferDecisionStatus.Pending)
        {
            throw new DomainException("transfer_decision.invalid_status", "The transfer is no longer pending.");
        }
    }
}

public enum TransferDecisionStatus
{
    Pending,
    Executed,
    Cancelled,
    Void,
}
