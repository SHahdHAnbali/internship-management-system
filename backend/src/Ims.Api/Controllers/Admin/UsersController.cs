using Ims.Api.Auth;
using Ims.Application.Admin.Users;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Ims.Api.Controllers.Admin;

[ApiController]
[Route("api/admin/users")]
[Authorize(Policy = AuthPolicies.Admin)]
public sealed class UsersController(UserManagement users) : ControllerBase
{
    [HttpGet]
    public Task<IReadOnlyList<UserDto>> List(CancellationToken cancellationToken) => users.ListAsync(cancellationToken);

    [HttpPut("{id:guid}/role")]
    public Task<UserDto> ChangeRole(Guid id, ChangeUserRoleRequest request, CancellationToken cancellationToken)
        => users.ChangeRoleAsync(id, request, cancellationToken);
}
