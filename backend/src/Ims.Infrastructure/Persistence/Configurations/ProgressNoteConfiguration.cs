using Ims.Domain.Mentoring;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class ProgressNoteConfiguration : IEntityTypeConfiguration<ProgressNote>
{
    public void Configure(EntityTypeBuilder<ProgressNote> builder)
    {
        builder.ToTable("progress_notes");
        builder.Property(n => n.Text).HasMaxLength(ProgressNote.TextMaxLength);
        builder.HasOne<Assignment>().WithMany().HasForeignKey(n => n.AssignmentId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(n => n.AuthorId);
    }
}
