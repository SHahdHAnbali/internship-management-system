using Ims.Application.Common.Email;
using Microsoft.Extensions.Logging;

namespace Ims.Infrastructure.Email;

/// <summary>Development only: writes e-mails to the console log instead of sending them.</summary>
internal sealed partial class LogEmailSender(ILogger<LogEmailSender> logger) : IEmailSender
{
    public Task SendAsync(EmailMessage message, CancellationToken cancellationToken)
    {
        LogEmail(logger, message.To, message.Subject, message.TextBody);
        return Task.CompletedTask;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "DEVELOPMENT E-MAIL (not sent) to {To}\nSubject: {Subject}\n{Body}")]
    private static partial void LogEmail(ILogger logger, string to, string subject, string body);
}
