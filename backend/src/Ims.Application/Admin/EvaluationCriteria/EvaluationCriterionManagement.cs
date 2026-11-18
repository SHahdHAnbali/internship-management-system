using Ims.Application.Common.Errors;
using Ims.Application.Common.Persistence;
using Ims.Domain.Evaluations;
using Microsoft.EntityFrameworkCore;

namespace Ims.Application.Admin.EvaluationCriteria;

/// <summary>Admin: manage the evaluation criteria (AD-66: Arabic and English names, order, active flag; no weights).</summary>
public sealed class EvaluationCriterionManagement(IAppDbContext db)
{
    public async Task<IReadOnlyList<EvaluationCriterionDto>> ListAsync(CancellationToken cancellationToken)
    {
        return await db.EvaluationCriteria
            .OrderBy(c => c.SortOrder).ThenBy(c => c.NameAr)
            .Select(c => new EvaluationCriterionDto(c.Id, c.NameAr, c.NameEn, c.SortOrder, c.IsActive))
            .ToListAsync(cancellationToken);
    }

    public async Task<EvaluationCriterionDto> CreateAsync(CreateEvaluationCriterionRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var criterion = EvaluationCriterion.Create(request.NameAr, request.NameEn, request.SortOrder);
        db.EvaluationCriteria.Add(criterion);
        await db.SaveChangesAsync(cancellationToken);
        return ToDto(criterion);
    }

    public async Task<EvaluationCriterionDto> UpdateAsync(Guid id, UpdateEvaluationCriterionRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var criterion = await db.EvaluationCriteria.SingleOrDefaultAsync(c => c.Id == id, cancellationToken)
            ?? throw NotFoundException.For<EvaluationCriterion>(id);
        criterion.Update(request.NameAr, request.NameEn, request.SortOrder, request.IsActive!.Value);
        await db.SaveChangesAsync(cancellationToken);
        return ToDto(criterion);
    }

    private static EvaluationCriterionDto ToDto(EvaluationCriterion c) => new(c.Id, c.NameAr, c.NameEn, c.SortOrder, c.IsActive);
}
