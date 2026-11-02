using System.Net;
using System.Net.Http.Json;
using Ims.Application.Auth;
using Ims.IntegrationTests.Infrastructure;

namespace Ims.IntegrationTests;

public sealed class RateLimitTests(RateLimitedApiFactory factory) : IClassFixture<RateLimitedApiFactory>
{
    [Fact]
    public async Task Trainee_sign_in_endpoints_are_rate_limited_per_client()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i <= RateLimitedApiFactory.Limit; i++)
        {
            statuses.Add((await client.PostAsJsonAsync("/api/auth/trainee/request", new TraineeCodeRequest("limit@uni.example"), ct)).StatusCode);
        }

        Assert.All(statuses.Take(RateLimitedApiFactory.Limit), s => Assert.Equal(HttpStatusCode.Accepted, s));
        Assert.Equal(HttpStatusCode.TooManyRequests, statuses[^1]);
    }
}
