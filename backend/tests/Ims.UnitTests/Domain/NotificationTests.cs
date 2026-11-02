using Ims.Domain.Common;
using Ims.Domain.Notifications;

namespace Ims.UnitTests.Domain;

public sealed class NotificationTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 31, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public void A_notification_starts_unread_and_can_be_marked_read()
    {
        var recipient = Guid.CreateVersion7();
        var entity = Guid.CreateVersion7();
        var notification = Notification.Create(recipient, NotificationType.ApplicationSubmitted, entity, Now);

        Assert.Equal(recipient, notification.RecipientId);
        Assert.Equal(entity, notification.EntityId);
        Assert.False(notification.IsRead);
        Assert.Equal(Now, notification.CreatedAt);

        notification.MarkRead();
        notification.MarkRead();
        Assert.True(notification.IsRead);
    }

    [Fact]
    public void A_notification_needs_a_recipient_a_known_type_and_a_record()
    {
        Assert.Throws<DomainException>(() =>
            Notification.Create(Guid.Empty, NotificationType.MentorRequestApproved, Guid.CreateVersion7(), Now));
        Assert.Throws<DomainException>(() =>
            Notification.Create(Guid.CreateVersion7(), (NotificationType)99, Guid.CreateVersion7(), Now));
        Assert.Throws<DomainException>(() =>
            Notification.Create(Guid.CreateVersion7(), NotificationType.MentorRequestApproved, Guid.Empty, Now));
    }
}
