using Ims.Domain.Applications;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class ApplicationAttachmentConfiguration : IEntityTypeConfiguration<ApplicationAttachment>
{
    public void Configure(EntityTypeBuilder<ApplicationAttachment> builder)
    {
        builder.ToTable("application_attachments", t =>
        {
            t.HasCheckConstraint("ck_application_attachments_size", "size_bytes > 0");
            t.HasCheckConstraint("ck_application_attachments_sha256", "sha256 ~ '^[0-9a-f]{64}$'");
        });
        builder.Property(a => a.FileName).HasMaxLength(ApplicationAttachment.FileNameMaxLength);
        builder.Property(a => a.ContentType).HasMaxLength(ApplicationAttachment.ContentTypeMaxLength);
        builder.Property(a => a.Sha256).HasMaxLength(64).IsFixedLength();
        builder.Property(a => a.StorageKey).HasMaxLength(ApplicationAttachment.StorageKeyMaxLength);
        builder.HasOne<TrainingApplication>().WithMany().HasForeignKey(a => a.ApplicationId);
        builder.HasIndex(a => a.StorageKey).IsUnique();
    }
}
