using Ims.Application.Common.Errors;
using Ims.Application.Common.Persistence;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;

namespace Ims.Application.Admin.Users;

/// <summary>Admin: manage users and their roles (PDF §2, §4). Accounts are created on first Google sign-in as Employee.</summary>
public sealed class UserManagement(IAppDbContext db)
{
    public async Task<IReadOnlyList<UserDto>> ListAsync(CancellationToken cancellationToken)
    {
        return await db.Employees
            .OrderBy(e => e.FullName)
            .Select(e => new UserDto(e.Id, e.FullName, e.Email, e.Department, e.Role))
            .ToListAsync(cancellationToken);
    }

    public async Task<UserDto> ChangeRoleAsync(Guid id, ChangeUserRoleRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var employee = await db.Employees.SingleOrDefaultAsync(e => e.Id == id, cancellationToken)
            ?? throw NotFoundException.For<Employee>(id);
        employee.ChangeRole(request.Role);
        await db.SaveChangesAsync(cancellationToken);
        return new UserDto(employee.Id, employee.FullName, employee.Email, employee.Department, employee.Role);
    }
}
