using Ims.Domain.Applications;
using Ims.Domain.Mentoring;
using Ims.Domain.Notifications;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class PendingRequestReminderConfiguration : IEntityTypeConfiguration<PendingRequestReminder>
{
    public void Configure(EntityTypeBuilder<PendingRequestReminder> builder)
    {
        builder.ToTable("pending_reminders", t =>
        {
            // Exactly the column of its kind is set.
            t.HasCheckConstraint(
                "ck_pending_reminders_target",
                "(kind = 'TrainingApplication' AND application_id IS NOT NULL AND mentor_request_id IS NULL) OR " +
                "(kind = 'MentorRequest' AND mentor_request_id IS NOT NULL AND application_id IS NULL)");
            t.HasCheckConstraint("ck_pending_reminders_recipients", "recipient_count >= 1");
            // The outcome is known exactly when the counts and the completion time are, and the counts add up.
            t.HasCheckConstraint(
                "ck_pending_reminders_result",
                "(outcome = 'Attempting') = (completed_at IS NULL) AND " +
                "(outcome = 'Attempting') = (accepted_count IS NULL AND failed_count IS NULL) AND " +
                "(outcome = 'Attempting' OR accepted_count + failed_count = recipient_count)");
        });
        builder.HasOne<TrainingApplication>().WithMany().HasForeignKey(r => r.ApplicationId);
        builder.HasOne<MentorRequest>().WithMany().HasForeignKey(r => r.MentorRequestId);
        // One reminder per request, enforced by the database (also under concurrent scheduled runs).
        builder.HasIndex(r => r.ApplicationId).IsUnique();
        builder.HasIndex(r => r.MentorRequestId).IsUnique();
    }
}
