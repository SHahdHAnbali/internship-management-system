using System.Net;
using Ims.IntegrationTests.Infrastructure;

namespace Ims.IntegrationTests;

public sealed class HostSmokeTests(ImsApiFactory factory) : IClassFixture<ImsApiFactory>
{
    [Fact]
    public async Task Health_endpoint_reports_healthy_when_database_is_reachable()
    {
        using var client = factory.CreateClient();

        var response = await client.GetAsync(new Uri("/health", UriKind.Relative), TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Healthy", await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task OpenApi_document_is_served_in_development()
    {
        using var client = factory.CreateClient();

        var response = await client.GetAsync(new Uri("/openapi/v1.json", UriKind.Relative), TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
