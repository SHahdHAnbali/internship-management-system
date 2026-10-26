using Ims.Application.Common.Persistence;
using Ims.Domain.Notifications;
using Microsoft.EntityFrameworkCore;

namespace Ims.Application.Admin.Settings;

/// <summary>Admin: the notification intervals (PDF §7: 7 / 3 / 5 days are settings the Admin changes).</summary>
public sealed class NotificationSettingsManagement(IAppDbContext db)
{
    public async Task<NotificationSettingsDto> GetAsync(CancellationToken cancellationToken)
    {
        return ToDto(await LoadAsync(cancellationToken));
    }

    public async Task<NotificationSettingsDto> UpdateAsync(NotificationSettingsDto request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var settings = await LoadAsync(cancellationToken);
        settings.Update(request.TrainingEndingNoticeDays, request.LateEvaluationReminderDays, request.PendingRequestAlertDays);
        await db.SaveChangesAsync(cancellationToken);
        return ToDto(settings);
    }

    private Task<NotificationSettings> LoadAsync(CancellationToken cancellationToken)
        => db.NotificationSettings.SingleAsync(s => s.Id == NotificationSettings.SingletonId, cancellationToken);

    private static NotificationSettingsDto ToDto(NotificationSettings s)
        => new(s.TrainingEndingNoticeDays, s.LateEvaluationReminderDays, s.PendingRequestAlertDays);
}
