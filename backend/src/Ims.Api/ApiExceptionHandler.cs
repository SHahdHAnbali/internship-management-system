using Ims.Application.Common.Errors;
using Ims.Domain.Common;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Ims.Api;

/// <summary>Maps domain and data errors to RFC 7807 ProblemDetails responses.</summary>
internal sealed class ApiExceptionHandler(IProblemDetailsService problemDetails) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        (int Status, string Code, string Detail)? problem = exception switch
        {
            DomainException e => (StatusCodes.Status400BadRequest, e.Code, e.Message),
            NotFoundException e => (StatusCodes.Status404NotFound, "not_found", e.Message),
            DbUpdateConcurrencyException => (StatusCodes.Status409Conflict, "conflict.concurrent_update",
                "The record was changed by someone else. Reload and try again."),
            DbUpdateException { InnerException: PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } } =>
                (StatusCodes.Status409Conflict, "conflict.duplicate", "A record with the same value already exists."),
            _ => null,
        };
        if (problem is not { } p)
        {
            return false;
        }

        httpContext.Response.StatusCode = p.Status;
        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Status = p.Status,
                Detail = p.Detail,
                Extensions = { ["code"] = p.Code },
            },
        });
    }
}
