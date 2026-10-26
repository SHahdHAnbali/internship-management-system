using Ims.Domain.Common;

namespace Ims.Domain.Evaluations;

/// <summary>A fixed evaluation criterion defined by Admin (PDF §4, §8: name, weight, order).</summary>
public sealed class EvaluationCriterion : Entity
{
    public const int NameMaxLength = 200;

    private EvaluationCriterion()
    {
        Name = null!;
    }

    public string Name { get; private set; }

    public decimal Weight { get; private set; }

    public int SortOrder { get; private set; }

    public static EvaluationCriterion Create(string name, decimal weight, int sortOrder)
    {
        var criterion = new EvaluationCriterion();
        criterion.Update(name, weight, sortOrder);
        return criterion;
    }

    public void Update(string name, decimal weight, int sortOrder)
    {
        if (weight <= 0)
        {
            throw new DomainException("validation.range", "Weight must be greater than zero.");
        }

        Name = Guard.Required(name, "Name", NameMaxLength);
        Weight = weight;
        SortOrder = sortOrder;
    }
}
