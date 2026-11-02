using Ims.Application.Common.Persistence;
using Ims.Domain.Roles;
using Microsoft.EntityFrameworkCore;

namespace Ims.Application.Auth;

/// <summary>
/// Reads the current state of a signed-in account from PostgreSQL. Used on every request, so role changes made by an
/// Admin take effect immediately. Returns only the caller's own record.
/// </summary>
public sealed class SessionLookup(IAppDbContext db)
{
    public async Task<SessionUser?> FindAsync(Guid userId, bool isTrainee, CancellationToken cancellationToken)
    {
        if (isTrainee)
        {
            return await db.Trainees.AsNoTracking()
                .Where(t => t.Id == userId)
                .Select(t => new SessionUser(t.Id, UserRole.Trainee, t.Email, null))
                .SingleOrDefaultAsync(cancellationToken);
        }

        return await db.Employees.AsNoTracking()
            .Where(e => e.Id == userId)
            .Select(e => new SessionUser(e.Id, e.Role, e.Email, e.FullName))
            .SingleOrDefaultAsync(cancellationToken);
    }
}
