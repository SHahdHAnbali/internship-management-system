using Ims.Application.Common.Errors;
using Ims.Application.Common.Persistence;
using Ims.Domain.Evaluations;
using Microsoft.EntityFrameworkCore;

namespace Ims.Application.Admin.EvaluationCriteria;

/// <summary>Admin: manage the evaluation criteria and their weights (PDF §4, §8: name, weight, order).</summary>
public sealed class EvaluationCriterionManagement(IAppDbContext db)
{
    public async Task<IReadOnlyList<EvaluationCriterionDto>> ListAsync(CancellationToken cancellationToken)
    {
        return await db.EvaluationCriteria
            .OrderBy(c => c.SortOrder).ThenBy(c => c.Name)
            .Select(c => new EvaluationCriterionDto(c.Id, c.Name, c.Weight, c.SortOrder))
            .ToListAsync(cancellationToken);
    }

    public async Task<EvaluationCriterionDto> CreateAsync(SaveEvaluationCriterionRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var criterion = EvaluationCriterion.Create(request.Name, request.Weight, request.SortOrder);
        db.EvaluationCriteria.Add(criterion);
        await db.SaveChangesAsync(cancellationToken);
        return ToDto(criterion);
    }

    public async Task<EvaluationCriterionDto> UpdateAsync(Guid id, SaveEvaluationCriterionRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var criterion = await db.EvaluationCriteria.SingleOrDefaultAsync(c => c.Id == id, cancellationToken)
            ?? throw NotFoundException.For<EvaluationCriterion>(id);
        criterion.Update(request.Name, request.Weight, request.SortOrder);
        await db.SaveChangesAsync(cancellationToken);
        return ToDto(criterion);
    }

    private static EvaluationCriterionDto ToDto(EvaluationCriterion c) => new(c.Id, c.Name, c.Weight, c.SortOrder);
}
