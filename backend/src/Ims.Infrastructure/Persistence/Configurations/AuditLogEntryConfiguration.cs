using Ims.Domain.Auditing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

/// <summary>Rows are inserted only by the <c>ims_audit_row_change</c> trigger (see the AdminModule migration).</summary>
internal sealed class AuditLogEntryConfiguration : IEntityTypeConfiguration<AuditLogEntry>
{
    public void Configure(EntityTypeBuilder<AuditLogEntry> builder)
    {
        builder.ToTable("audit_logs", t => t.HasCheckConstraint("ck_audit_logs_operation", "operation IN ('INSERT', 'UPDATE')"));
        builder.Property(a => a.Id).UseIdentityAlwaysColumn();
        builder.Property(a => a.DatabaseUser).HasMaxLength(128);
        builder.Property(a => a.Operation).HasMaxLength(6);
        builder.Property(a => a.TableName).HasMaxLength(128);
        builder.Property(a => a.EntityId).HasMaxLength(64);
        builder.Property(a => a.OldValues).HasColumnType("jsonb");
        builder.Property(a => a.NewValues).HasColumnType("jsonb");
        builder.HasIndex(a => new { a.TableName, a.EntityId });
        builder.HasIndex(a => a.OccurredAt);
        builder.HasIndex(a => a.ActorId);
    }
}
