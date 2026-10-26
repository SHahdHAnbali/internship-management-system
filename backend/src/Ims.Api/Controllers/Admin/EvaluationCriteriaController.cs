using Ims.Api.Auth;
using Ims.Application.Admin.EvaluationCriteria;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Ims.Api.Controllers.Admin;

[ApiController]
[Route("api/admin/evaluation-criteria")]
[Authorize(Policy = AuthPolicies.Admin)]
public sealed class EvaluationCriteriaController(EvaluationCriterionManagement criteria) : ControllerBase
{
    [HttpGet]
    public Task<IReadOnlyList<EvaluationCriterionDto>> List(CancellationToken cancellationToken) => criteria.ListAsync(cancellationToken);

    [HttpPost]
    public async Task<ActionResult<EvaluationCriterionDto>> Create(SaveEvaluationCriterionRequest request, CancellationToken cancellationToken)
    {
        var criterion = await criteria.CreateAsync(request, cancellationToken);
        return Created($"/api/admin/evaluation-criteria/{criterion.Id}", criterion);
    }

    [HttpPut("{id:guid}")]
    public Task<EvaluationCriterionDto> Update(Guid id, SaveEvaluationCriterionRequest request, CancellationToken cancellationToken)
        => criteria.UpdateAsync(id, request, cancellationToken);
}
