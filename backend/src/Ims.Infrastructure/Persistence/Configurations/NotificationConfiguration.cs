using Ims.Domain.Notifications;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class NotificationConfiguration : IEntityTypeConfiguration<Notification>
{
    public void Configure(EntityTypeBuilder<Notification> builder)
    {
        builder.ToTable("notifications");
        builder.HasOne<Employee>().WithMany().HasForeignKey(n => n.RecipientId);
        // One notification per recipient and event: a retried or concurrent write adds nothing.
        builder.HasIndex(n => new { n.RecipientId, n.Type, n.EntityId }).IsUnique();
    }
}
