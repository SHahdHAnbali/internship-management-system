using Ims.Domain.Common;

namespace Ims.Domain.Evaluations;

/// <summary>
/// An evaluation criterion defined by Admin (AD-66): an Arabic and an English name, an active flag and a display order that
/// the database assigns at creation (the next number, inactive criteria included) and never changes (AD-68 G7).
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

    /// <summary>Assigned by the database when the criterion is first saved (0 until then); never changed.</summary>
    public int SortOrder { get; private set; }

    public bool IsActive { get; private set; }

    public static EvaluationCriterion Create(string nameAr, string nameEn)
    {
        var criterion = new EvaluationCriterion();
        criterion.Update(nameAr, nameEn, isActive: true);
        return criterion;
    }

    public void Update(string nameAr, string nameEn, bool isActive)
    {
        NameAr = Guard.Required(nameAr, "Arabic name", NameMaxLength);
        NameEn = Guard.Required(nameEn, "English name", NameMaxLength);
        IsActive = isActive;
    }
}
