using Ims.Api.Auth;
using Ims.Application.Admin.Fields;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Ims.Api.Controllers.Admin;

[ApiController]
[Route("api/admin/fields")]
[Authorize(Policy = AuthPolicies.Admin)]
public sealed class FieldsController(FieldManagement fields) : ControllerBase
{
    [HttpGet]
    public Task<IReadOnlyList<FieldDto>> List(CancellationToken cancellationToken) => fields.ListAsync(cancellationToken);

    [HttpPost]
    public async Task<ActionResult<FieldDto>> Create(CreateFieldRequest request, CancellationToken cancellationToken)
    {
        var field = await fields.CreateAsync(request, cancellationToken);
        return Created($"/api/admin/fields/{field.Id}", field);
    }

    [HttpPut("{id:guid}")]
    public Task<FieldDto> Update(Guid id, UpdateFieldRequest request, CancellationToken cancellationToken)
        => fields.UpdateAsync(id, request, cancellationToken);
}
