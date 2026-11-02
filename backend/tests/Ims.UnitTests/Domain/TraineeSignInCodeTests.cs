using Ims.Domain.Common;
using Ims.Domain.Trainees;

namespace Ims.UnitTests.Domain;

public sealed class TraineeSignInCodeTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 26, 9, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);

    private static TraineeSignInCode Issue() =>
        TraineeSignInCode.Issue(Guid.CreateVersion7(), " Student@Uni.Example ", new string('a', 64), new string('b', 64), Now, Lifetime);

    [Fact]
    public void A_code_is_usable_until_15_minutes_after_issue()
    {
        var code = Issue();

        Assert.Equal("student@uni.example", code.Email);
        Assert.True(code.IsUsable(Now.AddMinutes(14).AddSeconds(59)));
        Assert.False(code.IsUsable(Now.AddMinutes(15)));
    }

    [Fact]
    public void A_code_can_be_used_only_once()
    {
        var code = Issue();
        code.MarkUsed(Now.AddMinutes(1));

        Assert.False(code.IsUsable(Now.AddMinutes(2)));
        Assert.Throws<DomainException>(() => code.MarkUsed(Now.AddMinutes(2)));
    }

    [Fact]
    public void A_newer_request_supersedes_the_code()
    {
        var code = Issue();
        code.Supersede(Now.AddMinutes(1));

        Assert.False(code.IsUsable(Now.AddMinutes(2)));
    }

    [Fact]
    public void Five_wrong_attempts_lock_the_code()
    {
        var code = Issue();
        for (var i = 0; i < TraineeSignInCode.MaxFailedAttempts - 1; i++)
        {
            code.RecordFailedAttempt();
        }

        Assert.True(code.IsUsable(Now));
        code.RecordFailedAttempt();
        Assert.False(code.IsUsable(Now));
    }

    [Fact]
    public void Trainee_accounts_use_normalised_emails()
    {
        Assert.Equal("a.b@uni.example", Trainee.Register(" A.B@Uni.Example ").Email);
        Assert.Throws<DomainException>(() => Trainee.Register("not-an-email"));
    }
}
