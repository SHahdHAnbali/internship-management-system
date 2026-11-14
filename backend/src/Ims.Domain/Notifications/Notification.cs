using Ims.Domain.Common;

namespace Ims.Domain.Notifications;

/// <summary>
/// An in-app notification for a staff member (PDF §7: the events whose channel includes "إشعار"; PDF §8 Notification:
/// recipient, type, read or not). <see cref="EntityId"/> names the record the event is about (an application or a
/// mentor request), so one event notifies each recipient once. The PDF's "email status" belongs to e-mail delivery,
/// which is not built. Never deleted.
/// </summary>
public sealed class Notification : Entity
{
    private Notification()
    {
    }

    /// <summary>The staff member (Employee table) it is for.</summary>
    public Guid RecipientId { get; private set; }

    public NotificationType Type { get; private set; }

    /// <summary>The application (ApplicationSubmitted) or mentor request (the other types) the event is about.</summary>
    public Guid EntityId { get; private set; }

    public bool IsRead { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public static Notification Create(Guid recipientId, NotificationType type, Guid entityId, DateTimeOffset now)
    {
        Guard.Defined(type, "Notification type");
        return new Notification
        {
            RecipientId = Guard.NotEmpty(recipientId, "Recipient"),
            Type = type,
            EntityId = Guard.NotEmpty(entityId, "Entity"),
            CreatedAt = Guard.Utc(now),
        };
    }

    public void MarkRead() => IsRead = true;
}

/// <summary>
/// The PDF §7 in-app events whose workflow exists: new training application (to HR), an employee asked to train a
/// trainee (to HR), and the assignment approved or rejected (to that employee).
/// </summary>
public enum NotificationType
{
    ApplicationSubmitted,
    MentorRequestSubmitted,
    MentorRequestApproved,
    MentorRequestRejected,

    /// <summary>HR assigned an accepted trainee directly to this employee (direct assignment, AD-67).</summary>
    TraineeDirectlyAssigned,
}
