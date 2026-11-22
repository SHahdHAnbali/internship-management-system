using Ims.Domain.Evaluations;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class EvaluationCorrectionConfiguration : IEntityTypeConfiguration<EvaluationCorrection>
{
    public void Configure(EntityTypeBuilder<EvaluationCorrection> builder)
    {
        builder.ToTable("evaluation_corrections");
        builder.Property(c => c.Reason).HasMaxLength(EvaluationCorrection.ReasonMaxLength);
        builder.HasOne<Evaluation>().WithMany().HasForeignKey(c => c.EvaluationId);
        builder.HasOne<Employee>().WithMany().HasForeignKey(c => c.CorrectedById);
    }
}
