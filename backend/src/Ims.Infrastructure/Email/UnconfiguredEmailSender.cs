using Ims.Application.Common.Email;

namespace Ims.Infrastructure.Email;

/// <summary>Used when no e-mail provider is configured: fails loudly instead of silently dropping sign-in codes.</summary>
internal sealed class UnconfiguredEmailSender : IEmailSender
{
    public Task SendAsync(EmailMessage message, CancellationToken cancellationToken) => throw new EmailNotConfiguredException();
}
