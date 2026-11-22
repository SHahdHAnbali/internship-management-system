using Ims.Domain.Evaluations;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Ims.Infrastructure.Persistence.Configurations;

internal sealed class EvaluationScoreConfiguration : IEntityTypeConfiguration<EvaluationScore>
{
    public void Configure(EntityTypeBuilder<EvaluationScore> builder)
    {
        builder.ToTable("evaluation_scores", t =>
        {
            t.HasCheckConstraint("ck_evaluation_scores_score", $"score BETWEEN {EvaluationScore.MinScore} AND {EvaluationScore.MaxScore}");
            // The snapshot frozen at submission: all of the criterion's names and order, or none (still a draft score).
            t.HasCheckConstraint(
                "ck_evaluation_scores_snapshot",
                "(frozen_name_ar IS NULL) = (frozen_name_en IS NULL) AND (frozen_name_ar IS NULL) = (frozen_sort_order IS NULL)");
            // AD-66: every active criterion is scored at submission, so a frozen row has a score.
            t.HasCheckConstraint("ck_evaluation_scores_frozen_scored", "frozen_sort_order IS NULL OR score IS NOT NULL");
        });
        builder.Property(s => s.FrozenNameAr).HasMaxLength(EvaluationCriterion.NameMaxLength);
        builder.Property(s => s.FrozenNameEn).HasMaxLength(EvaluationCriterion.NameMaxLength);
        builder.HasOne<Evaluation>().WithMany().HasForeignKey(s => s.EvaluationId);
        builder.HasOne<EvaluationCriterion>().WithMany().HasForeignKey(s => s.CriterionId);
        // One score per criterion; rows are never deleted, so a reactivated criterion finds its score again (AD-68 G5).
        builder.HasIndex(s => new { s.EvaluationId, s.CriterionId }).IsUnique();
    }
}
