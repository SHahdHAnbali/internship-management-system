using Ims.Domain.Common;

namespace Ims.Domain.Evaluations;

/// <summary>
/// A correction of a submitted final evaluation by a currently authorized evaluator (AD-66): who corrected it, when, and an
/// optional reason. Insert-only; the values before and after are in the audit log. The original submitter and submission
/// time stay on the <see cref="Evaluation"/>.
/// <para>Mapped for the schema only (AD-38): the corrections themselves are a later stage (S2.4).</para>
/// </summary>
public sealed class EvaluationCorrection : Entity
{
    public const int ReasonMaxLength = 2000;

    private EvaluationCorrection()
    {
    }

    public Guid EvaluationId { get; private set; }

    public Guid CorrectedById { get; private set; }

    public DateTimeOffset CorrectedAt { get; private set; }

    public string? Reason { get; private set; }
}
