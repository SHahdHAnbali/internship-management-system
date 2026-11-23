using System.Net;
using Docker.DotNet;
using Ims.IntegrationTests.Infrastructure;

namespace Ims.IntegrationTests;

/// <summary>
/// The container-start retry (S2.4 stabilization, owner decision of 2026-11-23) applies only to Docker's host-port
/// collision; every other Docker failure is thrown at once. No container is started here.
/// </summary>
public sealed class ContainerStartRetryTests
{
    private const string Collision =
        "{\"message\":\"failed to set up container networking: driver failed programming external connectivity on endpoint x (y): " +
        "failed to bind host port 0.0.0.0:55143/tcp: address already in use\"}";

    [Fact]
    public void IsHostPortCollision_bind_failure_address_in_use_is_retried() =>
        Assert.True(ImsApiFactory.IsHostPortCollision(new DockerApiException(HttpStatusCode.InternalServerError, Collision)));

    [Theory]
    [InlineData(HttpStatusCode.InternalServerError, "{\"message\":\"failed to bind host port 0.0.0.0:5432/tcp: permission denied\"}")]
    [InlineData(HttpStatusCode.InternalServerError, "{\"message\":\"address already in use\"}")]
    [InlineData(HttpStatusCode.InternalServerError, "{\"message\":\"No such image: postgres:18.6-alpine\"}")]
    [InlineData(HttpStatusCode.NotFound, "{\"message\":\"failed to bind host port 0.0.0.0:1/tcp: address already in use\"}")]
    [InlineData(HttpStatusCode.Conflict, "{\"message\":\"Conflict. The container name is already in use\"}")]
    public void IsHostPortCollision_any_other_docker_failure_is_not_retried(HttpStatusCode status, string body) =>
        Assert.False(ImsApiFactory.IsHostPortCollision(new DockerApiException(status, body)));

    [Fact]
    public void MaxContainerStartAttempts_is_three_in_all() => Assert.Equal(3, ImsApiFactory.MaxContainerStartAttempts);
}
