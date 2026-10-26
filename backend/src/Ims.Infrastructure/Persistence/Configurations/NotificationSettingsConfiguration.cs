using Ims.Domain.Notifications;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class NotificationSettingsConfiguration : IEntityTypeConfiguration<NotificationSettings>
{
    public void Configure(EntityTypeBuilder<NotificationSettings> builder)
    {
        builder.ToTable("notification_settings", t =>
        {
            t.HasCheckConstraint("ck_notification_settings_single_row", $"id = {NotificationSettings.SingletonId}");
            t.HasCheckConstraint(
                "ck_notification_settings_days",
                "training_ending_notice_days >= 1 AND late_evaluation_reminder_days >= 1 AND pending_request_alert_days >= 1");
        });
        builder.HasKey(s => s.Id);
        builder.Property(s => s.Id).ValueGeneratedNever();
        builder.HasData(Ims.Domain.Notifications.NotificationSettings.Defaults());
    }
}
