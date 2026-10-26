using Ims.Api.Auth;
using Ims.Application.Admin.Settings;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Ims.Api.Controllers.Admin;

[ApiController]
[Route("api/admin/settings/notifications")]
[Authorize(Policy = AuthPolicies.Admin)]
public sealed class SettingsController(NotificationSettingsManagement settings) : ControllerBase
{
    [HttpGet]
    public Task<NotificationSettingsDto> Get(CancellationToken cancellationToken) => settings.GetAsync(cancellationToken);

    [HttpPut]
    public Task<NotificationSettingsDto> Update(NotificationSettingsDto request, CancellationToken cancellationToken)
        => settings.UpdateAsync(request, cancellationToken);
}
