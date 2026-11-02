namespace Ims.Application.Common.Email;

/// <summary>Sends e-mail. The provider (SendGrid or Amazon SES, PDF §9) is not chosen yet (Q10).</summary>
public interface IEmailSender
{
    Task SendAsync(EmailMessage message, CancellationToken cancellationToken);
}

public sealed record EmailMessage(string To, string Subject, string TextBody);

/// <summary>No e-mail provider is configured, so the message cannot be delivered. Mapped to HTTP 503.</summary>
public sealed class EmailNotConfiguredException : Exception
{
    public EmailNotConfiguredException()
        : base("No e-mail provider is configured (Email:Provider).")
    {
    }

    public EmailNotConfiguredException(string message) : base(message)
    {
    }

    public EmailNotConfiguredException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
