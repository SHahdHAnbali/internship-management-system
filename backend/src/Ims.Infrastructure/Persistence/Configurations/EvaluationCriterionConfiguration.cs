using Ims.Domain.Evaluations;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class EvaluationCriterionConfiguration : IEntityTypeConfiguration<EvaluationCriterion>
{
    public void Configure(EntityTypeBuilder<EvaluationCriterion> builder)
    {
        builder.ToTable("evaluation_criteria", t => t.HasCheckConstraint("ck_evaluation_criteria_weight", "weight > 0"));
        builder.Property(c => c.Name).HasMaxLength(EvaluationCriterion.NameMaxLength);
        builder.Property(c => c.Weight).HasPrecision(9, 4);
    }
}
