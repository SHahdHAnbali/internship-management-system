using Ims.Domain.Common;

namespace Ims.Domain.Evaluations;

/// <summary>
/// One criterion's score in a final evaluation (AD-66): a whole number from 1 to 5, empty while drafting. A row is never
/// deleted, so a criterion deactivated during the draft keeps its score and shows it again when reactivated (AD-68 G5).
/// At submission the active criteria are frozen: their Arabic and English names and their order are copied here, so
/// later Admin changes never alter a submitted evaluation; a frozen row always has a score.
/// <para>Mapped for the schema only (AD-38): the Worker reads and, in later stages, writes it.</para>
/// </summary>
public sealed class EvaluationScore : Entity
{
    public const int MinScore = 1;
    public const int MaxScore = 5;

    private EvaluationScore()
    {
    }

    public Guid EvaluationId { get; private set; }

    public Guid CriterionId { get; private set; }

    public short? Score { get; private set; }

    public string? FrozenNameAr { get; private set; }

    public string? FrozenNameEn { get; private set; }

    public int? FrozenSortOrder { get; private set; }
}
