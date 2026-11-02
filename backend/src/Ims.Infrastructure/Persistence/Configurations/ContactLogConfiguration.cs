using Ims.Domain.Applications;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class ContactLogConfiguration : IEntityTypeConfiguration<ContactLog>
{
    public void Configure(EntityTypeBuilder<ContactLog> builder)
    {
        builder.ToTable("contact_logs");
        builder.Property(l => l.Summary).HasMaxLength(ContactLog.SummaryMaxLength);
        builder.HasOne<TrainingApplication>().WithMany().HasForeignKey(l => l.ApplicationId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(l => l.AuthorId);
    }
}
