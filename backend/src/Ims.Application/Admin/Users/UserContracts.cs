using Ims.Domain.Roles;

namespace Ims.Application.Admin.Users;

public sealed record UserDto(Guid Id, string FullName, string Email, string? Department, UserRole Role);

public sealed record ChangeUserRoleRequest(UserRole Role);
