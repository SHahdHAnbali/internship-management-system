using System.ComponentModel.DataAnnotations;
using Ims.Domain.Evaluations;

namespace Ims.Application.Admin.EvaluationCriteria;

public sealed record EvaluationCriterionDto(Guid Id, string Name, decimal Weight, int SortOrder);

public sealed record SaveEvaluationCriterionRequest(
    [Required, MaxLength(EvaluationCriterion.NameMaxLength)] string Name,
    [Range(typeof(decimal), "0.0001", "99999")] decimal Weight,
    int SortOrder);
