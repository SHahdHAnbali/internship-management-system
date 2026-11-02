namespace Ims.Infrastructure.Email;

public sealed class EmailOptions
{
    public const string SectionName = "Email";

    /// <summary>
    /// <c>Log</c> writes e-mails to the application log (local development only). Empty: no provider, sending fails with 503.
    /// The production provider (SendGrid or Amazon SES, PDF §9) is added once chosen (Q10).
    /// </summary>
    public string Provider { get; init; } = string.Empty;
}
