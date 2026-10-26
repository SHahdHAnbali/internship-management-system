using System.Net.Mail;

namespace Ims.Domain.Common;

/// <summary>Validates and normalises e-mail addresses (trimmed, lower-case) so uniqueness is case-insensitive.</summary>
public static class EmailAddress
{
    public const int MaxLength = 320;

    public static string Normalize(string? value)
    {
        var email = Guard.Required(value, "Email", MaxLength).ToLowerInvariant();
        if (!MailAddress.TryCreate(email, out var parsed) || parsed.Address != email)
        {
            throw new DomainException("validation.email", "Email is not a valid address.");
        }

        return email;
    }
}
