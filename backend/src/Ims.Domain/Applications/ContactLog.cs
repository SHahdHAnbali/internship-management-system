using Ims.Domain.Common;

namespace Ims.Domain.Applications;

/// <summary>
/// HR's record of a call or verbal agreement about an application (PDF §4, §8: application, author, date, method
/// phone / meeting / e-mail, summary). Recording entries is part of HR's review; no application decision depends on
/// them. Never deleted.
/// </summary>
public sealed class ContactLog : Entity
{
    public const int SummaryMaxLength = 4000;

    private ContactLog()
    {
        Summary = null!;
    }

    public Guid ApplicationId { get; private set; }

    /// <summary>The HR member who recorded it.</summary>
    public Guid AuthorId { get; private set; }

    public DateOnly ContactDate { get; private set; }

    public ContactMethod Method { get; private set; }

    public string Summary { get; private set; }

    public DateTimeOffset RecordedAt { get; private set; }

    public static ContactLog Record(
        Guid applicationId,
        Guid authorId,
        DateOnly contactDate,
        ContactMethod method,
        string summary,
        DateTimeOffset now)
    {
        Guard.Defined(method, "Contact method");
        return new ContactLog
        {
            ApplicationId = Guard.NotEmpty(applicationId, "Application"),
            AuthorId = Guard.NotEmpty(authorId, "Author"),
            ContactDate = contactDate,
            Method = method,
            Summary = Guard.Required(summary, "Summary", SummaryMaxLength),
            RecordedAt = Guard.Utc(now),
        };
    }
}

/// <summary>PDF §8: phone / meeting / e-mail.</summary>
public enum ContactMethod
{
    Phone,
    Meeting,
    Email,
}
