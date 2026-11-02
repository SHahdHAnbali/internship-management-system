using Ims.Application.Common.Persistence;
using Ims.Application.Common.Security;
using Ims.Domain.Common;
using Ims.Domain.Staff;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Ims.Application.Auth;

/// <summary>
/// Staff sign-in with Google (PDF §2, §9): only verified accounts of the company domain are accepted, and the first
/// sign-in creates the staff account with the Employee role. Higher roles are granted only by an Admin.
/// </summary>
public sealed class StaffSignIn(IAppDbContext db, IGoogleIdTokenValidator validator, IOptions<GoogleAuthOptions> options)
{
    private readonly GoogleAuthOptions _options = options.Value;

    public async Task<(SessionUser? User, StaffSignInFailure? Failure)> SignInAsync(string idToken, CancellationToken cancellationToken)
    {
        if (!_options.IsConfigured)
        {
            return (null, StaffSignInFailure.NotConfigured);
        }

        var identity = await validator.ValidateAsync(idToken, cancellationToken);
        if (identity is null)
        {
            return (null, StaffSignInFailure.InvalidToken);
        }

        if (!identity.EmailVerified)
        {
            return (null, StaffSignInFailure.EmailNotVerified);
        }

        var domain = _options.HostedDomain.Trim().ToLowerInvariant();
        var email = EmailAddress.Normalize(identity.Email);
        var hostedDomainMatches = string.Equals(identity.HostedDomain, domain, StringComparison.OrdinalIgnoreCase);
        if (!hostedDomainMatches || !email.EndsWith($"@{domain}", StringComparison.Ordinal))
        {
            return (null, StaffSignInFailure.DomainNotAllowed);
        }

        var employee = await db.Employees.SingleOrDefaultAsync(e => e.Email == email, cancellationToken);
        if (employee is null)
        {
            employee = Employee.CreateOnFirstSignIn(email, string.IsNullOrWhiteSpace(identity.Name) ? email : identity.Name);
            db.Employees.Add(employee);
            await db.SaveChangesAsync(cancellationToken);
        }

        return (new SessionUser(employee.Id, employee.Role, employee.Email, employee.FullName), null);
    }
}
