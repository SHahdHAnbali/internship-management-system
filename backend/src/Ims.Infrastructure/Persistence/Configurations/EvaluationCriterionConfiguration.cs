using Ims.Domain.Evaluations;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class EvaluationCriterionConfiguration : IEntityTypeConfiguration<EvaluationCriterion>
{
    public void Configure(EntityTypeBuilder<EvaluationCriterion> builder)
    {
        builder.ToTable("evaluation_criteria", t => t.HasCheckConstraint("ck_evaluation_criteria_weight", "weight IS NULL OR weight > 0"));
        builder.Property(c => c.NameAr).HasMaxLength(EvaluationCriterion.NameMaxLength);
        builder.Property(c => c.NameEn).HasMaxLength(EvaluationCriterion.NameMaxLength);

        // Legacy columns from before AD-66, kept so their values and history stay in place (migration EvaluationCriteriaBilingual):
        // `name` (the single name; the Worker keeps it equal to the Arabic name) and `weight` (no longer used by anything).
        builder.Property<string?>("Name").HasMaxLength(EvaluationCriterion.NameMaxLength);
        builder.Property<decimal?>("Weight").HasPrecision(9, 4);
    }
}
