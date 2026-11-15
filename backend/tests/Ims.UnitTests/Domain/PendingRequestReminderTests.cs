using Ims.Domain.Common;
using Ims.Domain.Notifications;

namespace Ims.UnitTests.Domain;

/// <summary>NEW-05 (AD-61 items 4–17): one reminder per pending request, with the SMTP server's answer, never "delivered".</summary>
public sealed class PendingRequestReminderTests
{
    private static readonly DateTimeOffset Now = new(2027, 3, 1, 7, 0, 0, TimeSpan.Zero);

    [Fact]
    public void A_reminder_is_attempting_until_its_outcome_is_recorded_once()
    {
        var reminder = PendingRequestReminder.ForApplication(Guid.CreateVersion7(), 3, Now);
        Assert.Equal((PendingRequestKind.TrainingApplication, ReminderOutcome.Attempting), (reminder.Kind, reminder.Outcome));
        Assert.Null(reminder.MentorRequestId);
        Assert.Null(reminder.CompletedAt);

        reminder.Complete(2, 1, Now.AddSeconds(5));
        Assert.Equal((ReminderOutcome.PartiallyAccepted, 2, 1), (reminder.Outcome, reminder.AcceptedCount!.Value, reminder.FailedCount!.Value));
        Assert.Equal("pending_reminder.completed", Assert.Throws<DomainException>(() => reminder.Complete(3, 0, Now)).Code);

        var accepted = PendingRequestReminder.ForMentorRequest(Guid.CreateVersion7(), 1, Now);
        accepted.Complete(1, 0, Now);
        Assert.Equal(ReminderOutcome.Accepted, accepted.Outcome);
        var failed = PendingRequestReminder.ForMentorRequest(Guid.CreateVersion7(), 1, Now);
        failed.Complete(0, 1, Now);
        Assert.Equal(ReminderOutcome.Failed, failed.Outcome);
    }

    [Fact]
    public void A_reminder_needs_a_recipient_and_counts_that_add_up()
    {
        Assert.Equal(
            "pending_reminder.no_recipient",
            Assert.Throws<DomainException>(() => PendingRequestReminder.ForApplication(Guid.CreateVersion7(), 0, Now)).Code);
        var reminder = PendingRequestReminder.ForMentorRequest(Guid.CreateVersion7(), 1, Now);
        Assert.Equal("pending_reminder.counts", Assert.Throws<DomainException>(() => reminder.Complete(1, 1, Now)).Code);
        Assert.Equal(ReminderOutcome.Attempting, reminder.Outcome);
    }
}
