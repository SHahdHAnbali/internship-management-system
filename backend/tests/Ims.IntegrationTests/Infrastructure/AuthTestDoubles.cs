using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Ims.Application.Common.Email;
using Ims.Application.Common.Security;

namespace Ims.IntegrationTests.Infrastructure;

/// <summary>The same API host, but requests authenticate with the real session cookie issued by /api/auth.</summary>
public class CookieAuthApiFactory : ImsApiFactory
{
    protected override bool UseTestAuthentication => false;
}

/// <summary>Cookie sign-in with a low trainee rate limit, to observe throttling.</summary>
public sealed class RateLimitedApiFactory : CookieAuthApiFactory
{
    public const int Limit = 3;

    protected override int TraineeRateLimitPerMinute => Limit;
}

/// <summary>Stands in for Google: a token is valid only if registered here.</summary>
public sealed class FakeGoogleIdTokenValidator : IGoogleIdTokenValidator
{
    private readonly ConcurrentDictionary<string, GoogleIdentity> _tokens = new();

    public string Issue(string email, string? hostedDomain, bool emailVerified = true, string? name = "Test User")
    {
        var token = $"google-token-{Guid.NewGuid():N}";
        _tokens[token] = new GoogleIdentity(email, emailVerified, name, hostedDomain);
        return token;
    }

    public Task<GoogleIdentity?> ValidateAsync(string idToken, CancellationToken cancellationToken)
        => Task.FromResult(_tokens.TryGetValue(idToken, out var identity) ? identity : null);
}

public sealed partial class CapturingEmailSender : IEmailSender
{
    private readonly ConcurrentQueue<EmailMessage> _sent = new();

    public IReadOnlyCollection<EmailMessage> Sent => _sent;

    public Task SendAsync(EmailMessage message, CancellationToken cancellationToken)
    {
        _sent.Enqueue(message);
        return Task.CompletedTask;
    }

    public EmailMessage LastTo(string to) => _sent.Last(m => m.To == to);

    public (string Code, string Token) LastSignInFor(string to)
    {
        var body = LastTo(to).TextBody;
        return (CodePattern().Match(body).Groups[1].Value, TokenPattern().Match(body).Groups[1].Value);
    }

    [GeneratedRegex(@"code: (\d{6})")]
    private static partial Regex CodePattern();

    [GeneratedRegex(@"verify\?token=([A-Za-z0-9_-]+)")]
    private static partial Regex TokenPattern();
}

public sealed class TestClock : TimeProvider
{
    public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;

    public override DateTimeOffset GetUtcNow() => Now;

    public void Advance(TimeSpan by) => Now += by;
}
