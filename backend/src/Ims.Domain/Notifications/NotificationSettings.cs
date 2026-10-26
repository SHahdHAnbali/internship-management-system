using Ims.Domain.Common;

namespace Ims.Domain.Notifications;

/// <summary>
/// The notification intervals Admin can change (PDF §7: "the durations (7 days, 3 days, 5 days) are settings the Admin changes").
/// A single row; the PDF values are the seeded defaults.
/// </summary>
public sealed class NotificationSettings
{
    public const int SingletonId = 1;

    public NotificationSettings(int trainingEndingNoticeDays, int lateEvaluationReminderDays, int pendingRequestAlertDays)
    {
        Update(trainingEndingNoticeDays, lateEvaluationReminderDays, pendingRequestAlertDays);
    }

    public int Id { get; private set; } = SingletonId;

    /// <summary>"Training end approaching (7 days before)" — notify employee and HR.</summary>
    public int TrainingEndingNoticeDays { get; private set; }

    /// <summary>"Late evaluation reminder (every 3 days)".</summary>
    public int LateEvaluationReminderDays { get; private set; }

    /// <summary>"Request pending more than 5 days" — e-mail HR.</summary>
    public int PendingRequestAlertDays { get; private set; }

    public static NotificationSettings Defaults() => new(7, 3, 5);

    public void Update(int trainingEndingNoticeDays, int lateEvaluationReminderDays, int pendingRequestAlertDays)
    {
        var endingNotice = Positive(trainingEndingNoticeDays, "Training ending notice");
        var lateReminder = Positive(lateEvaluationReminderDays, "Late evaluation reminder");
        var pendingAlert = Positive(pendingRequestAlertDays, "Pending request alert");
        (TrainingEndingNoticeDays, LateEvaluationReminderDays, PendingRequestAlertDays) = (endingNotice, lateReminder, pendingAlert);
    }

    private static int Positive(int days, string name)
    {
        return days >= 1 ? days : throw new DomainException("validation.range", $"{name} must be at least 1 day.");
    }
}
