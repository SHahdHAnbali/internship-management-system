using Ims.Domain.Common;

namespace Ims.Domain.Evaluations;

/// <summary>
/// An evaluation criterion defined by Admin (AD-66): an Arabic and an English name, a display order and an active flag.
/// No weights: every active criterion counts equally. Never deleted; deactivated instead.
/// </summary>
public sealed class EvaluationCriterion : Entity
{
    public const int NameMaxLength = 200;

    private EvaluationCriterion()
    {
        NameAr = null!;
        NameEn = null!;
    }

    public string NameAr { get; private set; }

    public string NameEn { get; private set; }

    public int SortOrder { get; private set; }

    public bool IsActive { get; private set; }

    public static EvaluationCriterion Create(string nameAr, string nameEn, int sortOrder)
    {
        var criterion = new EvaluationCriterion();
        criterion.Update(nameAr, nameEn, sortOrder, isActive: true);
        return criterion;
    }

    public void Update(string nameAr, string nameEn, int sortOrder, bool isActive)
    {
        NameAr = Guard.Required(nameAr, "Arabic name", NameMaxLength);
        NameEn = Guard.Required(nameEn, "English name", NameMaxLength);
        SortOrder = sortOrder;
        IsActive = isActive;
    }
}
