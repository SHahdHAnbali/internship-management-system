using Ims.Domain.Fields;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class FieldConfiguration : IEntityTypeConfiguration<Field>
{
    public void Configure(EntityTypeBuilder<Field> builder)
    {
        // Case-insensitive uniqueness of the name is the lower(name) expression index ux_fields_name_ci (see migration).
        builder.ToTable("fields");
        builder.Property(f => f.Name).HasMaxLength(Field.NameMaxLength);
        builder.Property(f => f.Description).HasMaxLength(Field.DescriptionMaxLength);
    }
}
