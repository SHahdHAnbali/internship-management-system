using System.Security.Cryptography;
using System.Text;
using Ims.Application.Common.Email;
using Ims.Application.Common.Persistence;
using Ims.Domain.Common;
using Ims.Domain.Roles;
using Ims.Domain.Trainees;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Ims.Application.Auth;

/// <summary>
/// Passwordless trainee registration and sign-in (PDF §2, §4, §9): a one-time link and code are e-mailed, valid for
/// 15 minutes and usable once. The trainee account is created on the first successful verification.
/// </summary>
public sealed class TraineeSignIn(IAppDbContext db, IEmailSender email, TimeProvider clock, IOptions<TraineeSignInOptions> options)
{
    private const int CodeDigits = 6;
    private readonly TraineeSignInOptions _options = options.Value;

    /// <summary>
    /// E-mails a new link and code and invalidates earlier ones. The response is the same whether or not the e-mail
    /// belongs to an existing trainee, so the endpoint cannot be used to discover accounts.
    /// </summary>
    public async Task RequestAsync(string emailAddress, CancellationToken cancellationToken)
    {
        var address = EmailAddress.Normalize(emailAddress);
        var now = clock.GetUtcNow();

        var open = await db.TraineeSignInCodes
            .Where(c => c.Email == address && c.UsedAt == null && c.SupersededAt == null && c.ExpiresAt > now)
            .ToListAsync(cancellationToken);
        open.ForEach(c => c.Supersede(now));

        var id = Guid.CreateVersion7();
        var token = Base64Url(RandomNumberGenerator.GetBytes(32));
        var code = RandomNumberGenerator.GetInt32(0, (int)Math.Pow(10, CodeDigits)).ToString($"D{CodeDigits}", System.Globalization.CultureInfo.InvariantCulture);
        var lifetime = TimeSpan.FromMinutes(_options.CodeLifetimeMinutes);
        db.TraineeSignInCodes.Add(TraineeSignInCode.Issue(id, address, Hash(token), HashCode(id, code), now, lifetime));

        // Send before saving: if delivery fails, the trainee's earlier code stays valid and no undelivered code is stored.
        await email.SendAsync(BuildMessage(address, token, code), cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
    }

    /// <summary>Verifies an e-mail + code pair. Wrong codes count towards the attempt limit.</summary>
    public async Task<SessionUser?> VerifyCodeAsync(string emailAddress, string code, CancellationToken cancellationToken)
    {
        var address = EmailAddress.Normalize(emailAddress);
        var now = clock.GetUtcNow();
        var latest = await db.TraineeSignInCodes
            .Where(c => c.Email == address && c.UsedAt == null && c.SupersededAt == null)
            .OrderByDescending(c => c.IssuedAt)
            .FirstOrDefaultAsync(cancellationToken);
        if (latest is null || !latest.IsUsable(now))
        {
            return null;
        }

        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(HashCode(latest.Id, code.Trim())), Encoding.ASCII.GetBytes(latest.CodeHash)))
        {
            latest.RecordFailedAttempt();
            await db.SaveChangesAsync(cancellationToken);
            return null;
        }

        return await CompleteAsync(latest, now, cancellationToken);
    }

    /// <summary>Verifies the secret from the e-mailed link.</summary>
    public async Task<SessionUser?> VerifyTokenAsync(string token, CancellationToken cancellationToken)
    {
        var hash = Hash(token.Trim());
        var now = clock.GetUtcNow();
        var signInCode = await db.TraineeSignInCodes.SingleOrDefaultAsync(c => c.TokenHash == hash, cancellationToken);
        return signInCode is not null && signInCode.IsUsable(now) ? await CompleteAsync(signInCode, now, cancellationToken) : null;
    }

    private async Task<SessionUser> CompleteAsync(TraineeSignInCode signInCode, DateTimeOffset now, CancellationToken cancellationToken)
    {
        signInCode.MarkUsed(now);
        var trainee = await db.Trainees.SingleOrDefaultAsync(t => t.Email == signInCode.Email, cancellationToken);
        if (trainee is null)
        {
            trainee = Trainee.Register(signInCode.Email);
            db.Trainees.Add(trainee);
        }

        await db.SaveChangesAsync(cancellationToken);
        return new SessionUser(trainee.Id, UserRole.Trainee, trainee.Email, null);
    }

    private EmailMessage BuildMessage(string to, string token, string code)
    {
        var link = $"{_options.SignInLinkBaseUrl.TrimEnd('/')}/sign-in/verify?token={token}";
        var minutes = _options.CodeLifetimeMinutes;
        // PDF §7: templates in Arabic and English.
        var body =
            $"""
            رمز الدخول إلى نظام إدارة المتدربين: {code}
            أو افتح هذا الرابط لتسجيل الدخول مباشرة:
            {link}
            الرمز والرابط صالحان لمدة {minutes} دقيقة ولمرة واحدة فقط. إذا لم تطلب ذلك فتجاهل هذه الرسالة.

            Your Trainee Management System sign-in code: {code}
            Or open this link to sign in directly:
            {link}
            The code and link are valid for {minutes} minutes and can be used once. If you did not request this, ignore this e-mail.
            """;
        return new EmailMessage(to, $"رمز الدخول / Sign-in code: {code}", body);
    }

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static string HashCode(Guid id, string code) => Hash($"{id:N}:{code}");

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
