using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using Ims.Domain.Evaluations;

namespace Ims.Application.Admin.EvaluationCriteria;

public sealed record EvaluationCriterionDto(Guid Id, string NameAr, string NameEn, int SortOrder, bool IsActive);

/// <summary>
/// A new criterion is active (AD-66); its order is assigned by the database (AD-68 G7). Any other property, such as a
/// `sortOrder`, is refused (400): a client never sets the order.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CreateEvaluationCriterionRequest(
    [Required, MaxLength(EvaluationCriterion.NameMaxLength)] string NameAr,
    [Required, MaxLength(EvaluationCriterion.NameMaxLength)] string NameEn);

/// <summary>
/// `IsActive` must be sent: nullable only so that a missing or null value is a 400, never a silent false. The order never
/// changes, and any other property, such as a `sortOrder`, is refused (400).
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record UpdateEvaluationCriterionRequest(
    [Required, MaxLength(EvaluationCriterion.NameMaxLength)] string NameAr,
    [Required, MaxLength(EvaluationCriterion.NameMaxLength)] string NameEn,
    [Required] bool? IsActive);
