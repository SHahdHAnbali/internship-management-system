using Ims.Domain.Common;

namespace Ims.Domain.Mentoring;

/// <summary>
/// The link between a transferred assignment and the assignment that continues the training with the incoming mentor
/// (PDF §4 «نقل المتدرب لموظف آخر»; AD-65, owner 2026-11-13): an executed <see cref="TransferDecision"/>, with the HR
/// member who decided it and the actual execution time. The effective date is the incoming assignment's start date
/// (and the decision's), which never changes; the reason is the outgoing assignment's end reason. Created by
/// <see cref="TransferDecision.Execute"/>. Insert-only and never deleted; an assignment is transferred at most once and is
/// the continuation of at most one transfer, so the links form the chain of mentors of one training. The scheduled job
/// executes as the System actor in the audit log; <see cref="TransferredById"/> stays the deciding HR.
/// </summary>
public sealed class AssignmentTransfer : Entity
{
    private AssignmentTransfer()
    {
    }

    public Guid DecisionId { get; private set; }

    public Guid FromAssignmentId { get; private set; }

    public Guid ToAssignmentId { get; private set; }

    public Guid TransferredById { get; private set; }

    /// <summary>When the transfer was actually executed (not the effective date).</summary>
    public DateTimeOffset TransferredAt { get; private set; }

    internal static AssignmentTransfer Record(
        Guid decisionId,
        Guid fromAssignmentId,
        Guid toAssignmentId,
        Guid hrId,
        DateTimeOffset now)
    {
        if (fromAssignmentId == toAssignmentId)
        {
            throw new DomainException("assignment.transfer_self", "An assignment cannot be transferred to itself.");
        }

        return new AssignmentTransfer
        {
            DecisionId = Guard.NotEmpty(decisionId, "Transfer decision"),
            FromAssignmentId = Guard.NotEmpty(fromAssignmentId, "Outgoing assignment"),
            ToAssignmentId = Guard.NotEmpty(toAssignmentId, "Incoming assignment"),
            TransferredById = Guard.NotEmpty(hrId, "HR"),
            TransferredAt = Guard.Utc(now),
        };
    }
}
