using Ims.Domain.Common;
using Ims.Domain.Mentoring;

namespace Ims.UnitTests.Domain;

/// <summary>
/// AD-65 (revised 2026-11-13): the current responsible HR decides a transfer for today (executed at once) or a later date
/// (Pending until executed on that date); the outgoing assignment ends the day before, the incoming starts on the date.
/// </summary>
public sealed class TransferTests
{
    private static readonly DateTimeOffset Now = new(2027, 2, 15, 9, 0, 0, TimeSpan.Zero);
    private static readonly DateOnly Today = new(2027, 2, 15);
    private static readonly Guid Hr = Guid.CreateVersion7();
    private static readonly Guid MentorA = Guid.CreateVersion7();
    private static readonly Guid MentorB = Guid.CreateVersion7();

    private static Assignment Active(Guid mentor) => MentorRequest.Create(mentor, Guid.CreateVersion7(), "Work", Now)
        .Approve(Hr, new DateOnly(2027, 1, 3), new DateOnly(2027, 3, 31), Now);

    private static string Code(Action action) => Assert.Throws<DomainException>(action).Code;

    [Fact]
    public void DecideTransfer_today_executes_with_outgoing_ending_day_before_and_incoming_keeping_planned_end()
    {
        var outgoing = Active(MentorA);

        var decision = outgoing.DecideTransfer(MentorB, Today, " New project ", Hr, Today, Now);
        Assert.Equal(TransferDecisionStatus.Pending, decision.Status);
        Assert.Equal(AssignmentStatus.Active, outgoing.Status);
        var (incoming, link) = decision.Execute(outgoing, Today, Now);

        Assert.Equal(TransferDecisionStatus.Executed, decision.Status);
        Assert.Equal(Now, decision.ResolvedAt);
        Assert.Equal(AssignmentStatus.Transferred, outgoing.Status);
        Assert.Equal(new DateOnly(2027, 2, 14), outgoing.EndDate);
        Assert.Equal("New project", outgoing.EndReason);
        Assert.Equal(AssignmentStatus.Active, incoming.Status);
        Assert.Equal(outgoing.ApplicationId, incoming.ApplicationId);
        Assert.Equal(MentorB, incoming.EmployeeId);
        Assert.Null(incoming.MentorRequestId);
        Assert.Equal(Today, incoming.StartDate);
        Assert.Equal(new DateOnly(2027, 3, 31), incoming.EndDate);
        Assert.Equal(
            (decision.Id, outgoing.Id, incoming.Id, Hr),
            (link.DecisionId, link.FromAssignmentId, link.ToAssignmentId, link.TransferredById));

        // A chain: the incoming assignment can itself be transferred later, back to an earlier mentor too.
        var tomorrow = Today.AddDays(1);
        var (third, _) = incoming.DecideTransfer(MentorA, tomorrow, "Back", Hr, Today, Now)
            .Execute(incoming, tomorrow, Now.AddDays(1));
        Assert.Equal(Today, incoming.EndDate);
        Assert.Equal(tomorrow, third.StartDate);
    }

    [Fact]
    public void Scheduled_transfer_changes_nothing_until_due_and_inherits_the_planned_end_at_execution()
    {
        var outgoing = Active(MentorA);
        var effective = new DateOnly(2027, 3, 1);

        var decision = outgoing.DecideTransfer(MentorB, effective, "Later", Hr, Today, Now);
        Assert.Equal("transfer_decision.not_due", Code(() => decision.Execute(outgoing, effective.AddDays(-1), Now)));
        Assert.Equal(AssignmentStatus.Active, outgoing.Status);
        Assert.Equal(TransferDecisionStatus.Pending, decision.Status);

        outgoing.Extend(new DateOnly(2027, 4, 30), "More work", Hr, Now);
        // Executed late (after an outage): the dates are the decision's, the time the actual one.
        var executedAt = Now.AddDays(20);
        var (incoming, link) = decision.Execute(outgoing, effective.AddDays(2), executedAt);

        Assert.Equal(new DateOnly(2027, 2, 28), outgoing.EndDate);
        Assert.Equal(effective, incoming.StartDate);
        Assert.Equal(new DateOnly(2027, 4, 30), incoming.EndDate);
        Assert.Equal(executedAt, link.TransferredAt);
        Assert.Equal(Now, decision.DecidedAt);
        Assert.Equal("transfer_decision.invalid_status", Code(() => decision.Execute(outgoing, effective, Now)));
    }

    [Fact]
    public void DecideTransfer_invalid_date_mentor_reason_or_status_throws_and_changes_nothing()
    {
        var assignment = Active(MentorA);

        Assert.Equal("assignment.transfer_in_past", Code(() => assignment.DecideTransfer(MentorB, Today.AddDays(-1), "x", Hr, Today, Now)));
        Assert.Equal("assignment.transfer_not_after_start", Code(() => assignment.DecideTransfer(MentorB, new DateOnly(2027, 1, 3), "x", Hr, new DateOnly(2027, 1, 3), Now)));
        Assert.Equal("assignment.transfer_not_after_start", Code(() => assignment.DecideTransfer(MentorB, new DateOnly(2027, 1, 2), "x", Hr, new DateOnly(2027, 1, 1), Now)));
        Assert.Equal("assignment.transfer_after_end", Code(() => assignment.DecideTransfer(MentorB, new DateOnly(2027, 4, 1), "x", Hr, Today, Now)));
        Assert.Equal("assignment.transfer_same_mentor", Code(() => assignment.DecideTransfer(MentorA, Today, "x", Hr, Today, Now)));
        Assert.Throws<DomainException>(() => assignment.DecideTransfer(MentorB, Today, "  ", Hr, Today, Now));
        Assert.Equal(AssignmentStatus.Active, assignment.Status);
        Assert.Equal(new DateOnly(2027, 3, 31), assignment.EndDate);

        assignment.DecideTransfer(MentorB, Today, "Moved", Hr, Today, Now).Execute(assignment, Today, Now);
        Assert.Equal("assignment.invalid_status", Code(() => assignment.DecideTransfer(MentorB, Today, "x", Hr, Today, Now)));
    }

    [Fact]
    public void Pending_decision_can_be_cancelled_with_a_reason_or_voided_once_and_is_kept()
    {
        var assignment = Active(MentorA);
        var cancelled = assignment.DecideTransfer(MentorB, Today.AddDays(5), "Plan", Hr, Today, Now);

        Assert.Throws<DomainException>(() => cancelled.Cancel(Hr, " ", Now));
        cancelled.Cancel(Hr, " Changed plan ", Now);
        Assert.Equal(TransferDecisionStatus.Cancelled, cancelled.Status);
        Assert.Equal((Hr, "Changed plan", Now), (cancelled.ResolvedById!.Value, cancelled.ResolutionReason!, cancelled.ResolvedAt!.Value));
        Assert.Equal("Plan", cancelled.Reason);
        Assert.Equal("transfer_decision.invalid_status", Code(() => cancelled.Cancel(Hr, "Again", Now)));
        Assert.Equal("transfer_decision.invalid_status", Code(() => cancelled.Execute(assignment, Today.AddDays(5), Now)));

        var voided = assignment.DecideTransfer(MentorB, Today.AddDays(5), "Plan", Hr, Today, Now);
        voided.Void("mentor_not_employee", Now);
        Assert.Equal((TransferDecisionStatus.Void, "mentor_not_employee"), (voided.Status, voided.ResolutionCode!));
        Assert.Null(voided.ResolvedById);
        Assert.Equal("transfer_decision.invalid_status", Code(() => voided.Void("training_ended", Now)));
        Assert.Equal(AssignmentStatus.Active, assignment.Status);
    }
}
