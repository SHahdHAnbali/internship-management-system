using System.Data.Common;
using Ims.Application.Common.Security;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Ims.Infrastructure.Persistence.Interceptors;

/// <summary>
/// Tells PostgreSQL who is acting, so the audit triggers can record it. Runs on every connection open, which
/// covers SaveChanges, ExecuteUpdate/ExecuteDelete and raw SQL issued through the context alike. The settings are
/// session-scoped and Npgsql resets session state when a pooled connection is reused, so they never leak between users.
/// </summary>
internal sealed class AuditActorConnectionInterceptor(ICurrentUser currentUser) : DbConnectionInterceptor
{
    private const string Sql = "SELECT set_config('ims.actor_type', @actor_type, false), set_config('ims.actor_id', @actor_id, false)";

    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData)
    {
        using var command = CreateCommand(connection);
        command.ExecuteNonQuery();
    }

    public override async Task ConnectionOpenedAsync(
        DbConnection connection, ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        await using var command = CreateCommand(connection);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private DbCommand CreateCommand(DbConnection connection)
    {
        var command = connection.CreateCommand();
        command.CommandText = Sql;
        AddParameter(command, "actor_type", currentUser.ActorType.ToString());
        AddParameter(command, "actor_id", currentUser.UserId?.ToString() ?? string.Empty);
        return command;
    }

    private static void AddParameter(DbCommand command, string name, string value)
    {
        var parameter = command.CreateParameter();
        parameter.ParameterName = name;
        parameter.Value = value;
        command.Parameters.Add(parameter);
    }
}
