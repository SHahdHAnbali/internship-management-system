using Ims.Domain.Common;

namespace Ims.Domain.Evaluations;

/// <summary>
/// The final evaluation of a training application (R27; AD-66, AD-68 G2–G8): exactly one per application, available
/// once HR has ended the training as Completed or EndedEarly. One shared <see cref="EvaluationStatus.Draft"/> that the
/// final mentor and the current responsible HR may both edit, then <see cref="EvaluationStatus.Submitted"/> by the first
/// successful submission, which records who submitted it and when. The comment is optional while drafting and required
/// at submission, like the hiring recommendation. <see cref="Revision"/> grows with every saved change, so concurrent
/// editors detect each other. The numeric mean and the verbal grade are never stored: the grade is derived from the
/// frozen scores when needed and the mean is never exposed (G8).
/// <para>Mapped for the schema only (owned by these migrations, AD-38): the Worker reads and, in later stages, writes it.</para>
/// </summary>
public sealed class Evaluation : Entity
{
    public const int CommentMaxLength = 4000;

    private Evaluation()
    {
    }

    public Guid ApplicationId { get; private set; }

    /// <summary>The training's latest assignment, ended, when the evaluation was started (its mentor is the final mentor).</summary>
    public Guid AssignmentId { get; private set; }

    public EvaluationStatus Status { get; private set; }

    public string? Comment { get; private set; }

    public HiringRecommendation? HiringRecommendation { get; private set; }

    /// <summary>Starts at 0 and grows by one with every saved change (column <c>version</c>; <c>Version</c> is xmin).</summary>
    public int Revision { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    /// <summary>Whoever actually submitted it (the final mentor or the responsible HR); kept through later corrections.</summary>
    public Guid? SubmittedById { get; private set; }

    public DateTimeOffset? SubmittedAt { get; private set; }
}

public enum EvaluationStatus
{
    Draft,
    Submitted,
}

/// <summary>PDF §4: the evaluator's hiring recommendation; required at submission and never shown to the trainee.</summary>
public enum HiringRecommendation
{
    Yes,
    Maybe,
    No,
}
