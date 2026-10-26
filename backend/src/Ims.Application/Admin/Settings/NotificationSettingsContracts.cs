using System.ComponentModel.DataAnnotations;

namespace Ims.Application.Admin.Settings;

public sealed record NotificationSettingsDto(
    [Range(1, 365)] int TrainingEndingNoticeDays,
    [Range(1, 365)] int LateEvaluationReminderDays,
    [Range(1, 365)] int PendingRequestAlertDays);
