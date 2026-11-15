using Ims.Domain.Common;

namespace Ims.Domain.Notifications;

/// <summary>
/// The one e-mail reminder to HR about a request that has been pending for more than the Admin's
/// <c>pending_request_alert_days</c> (PDF §7 «طلب معلّق أكثر من 5 أيام»; AD-61 items 4–17, NEW-05): a training application
/// still Submitted or Under Review, or a mentor request still Pending. At most one per request (unique), never deleted.
/// It is recorded (<see cref="ReminderOutcome.Attempting"/>) only when the reminder is actually attempted, that is when
/// event e-mails are enabled and at least one eligible HR recipient exists, before any e-mail is sent; once every send
/// has been attempted, the outcome records what the SMTP server answered (accepted by the server, never "delivered").
/// A row left at <see cref="ReminderOutcome.Attempting"/> means the run stopped before the outcome was written.
/// </summary>
public sealed class PendingRequestReminder : Entity
{
    private PendingRequestReminder()
    {
    }

    public PendingRequestKind Kind { get; private set; }

    /// <summary>The pending training application (for <see cref="PendingRequestKind.TrainingApplication"/>).</summary>
    public Guid? ApplicationId { get; private set; }

    /// <summary>The pending mentor request (for <see cref="PendingRequestKind.MentorRequest"/>).</summary>
    public Guid? MentorRequestId { get; private set; }

    /// <summary>When the reminder was claimed for sending, just before the e-mails.</summary>
    public DateTimeOffset AttemptedAt { get; private set; }

    /// <summary>How many HR recipients the reminder was addressed to.</summary>
    public int RecipientCount { get; private set; }

    public ReminderOutcome Outcome { get; private set; }

    /// <summary>How many of the e-mails the SMTP server accepted (once the outcome is known).</summary>
    public int? AcceptedCount { get; private set; }

    /// <summary>How many of the e-mails failed (once the outcome is known).</summary>
    public int? FailedCount { get; private set; }

    public DateTimeOffset? CompletedAt { get; private set; }

    public static PendingRequestReminder ForApplication(Guid applicationId, int recipientCount, DateTimeOffset now) =>
        Create(PendingRequestKind.TrainingApplication, Guard.NotEmpty(applicationId, "Application"), null, recipientCount, now);

    public static PendingRequestReminder ForMentorRequest(Guid mentorRequestId, int recipientCount, DateTimeOffset now) =>
        Create(PendingRequestKind.MentorRequest, null, Guard.NotEmpty(mentorRequestId, "Mentor request"), recipientCount, now);

    /// <summary>Records what the SMTP server answered for each e-mail of this reminder, once.</summary>
    public void Complete(int acceptedCount, int failedCount, DateTimeOffset now)
    {
        if (Outcome != ReminderOutcome.Attempting)
        {
            throw new DomainException("pending_reminder.completed", "The reminder's outcome is already recorded.");
        }

        if (acceptedCount < 0 || failedCount < 0 || acceptedCount + failedCount != RecipientCount)
        {
            throw new DomainException("pending_reminder.counts", "Every recipient must be either accepted or failed.");
        }

        AcceptedCount = acceptedCount;
        FailedCount = failedCount;
        Outcome = failedCount == 0 ? ReminderOutcome.Accepted
            : acceptedCount == 0 ? ReminderOutcome.Failed
            : ReminderOutcome.PartiallyAccepted;
        CompletedAt = Guard.Utc(now);
    }

    private static PendingRequestReminder Create(
        PendingRequestKind kind,
        Guid? applicationId,
        Guid? mentorRequestId,
        int recipientCount,
        DateTimeOffset now)
    {
        if (recipientCount < 1)
        {
            throw new DomainException(
                "pending_reminder.no_recipient",
                "A reminder is recorded only when at least one eligible HR recipient exists.");
        }

        return new PendingRequestReminder
        {
            Kind = kind,
            ApplicationId = applicationId,
            MentorRequestId = mentorRequestId,
            RecipientCount = recipientCount,
            AttemptedAt = Guard.Utc(now),
            Outcome = ReminderOutcome.Attempting,
        };
    }
}

public enum PendingRequestKind
{
    TrainingApplication,
    MentorRequest,
}

/// <summary>What the SMTP server answered for a reminder's e-mails (acceptance is not confirmed delivery).</summary>
public enum ReminderOutcome
{
    Attempting,
    Accepted,
    PartiallyAccepted,
    Failed,
}
