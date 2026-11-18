using System.ComponentModel.DataAnnotations;
using Ims.Domain.Evaluations;

namespace Ims.Application.Admin.EvaluationCriteria;

public sealed record EvaluationCriterionDto(Guid Id, string NameAr, string NameEn, int SortOrder, bool IsActive);

/// <summary>A new criterion is active (AD-66).</summary>
public sealed record CreateEvaluationCriterionRequest(
    [Required, MaxLength(EvaluationCriterion.NameMaxLength)] string NameAr,
    [Required, MaxLength(EvaluationCriterion.NameMaxLength)] string NameEn,
    int SortOrder);

/// <summary>`IsActive` must be sent: nullable only so that a missing or null value is a 400, never a silent false.</summary>
public sealed record UpdateEvaluationCriterionRequest(
    [Required, MaxLength(EvaluationCriterion.NameMaxLength)] string NameAr,
    [Required, MaxLength(EvaluationCriterion.NameMaxLength)] string NameEn,
    int SortOrder,
    [Required] bool? IsActive);
