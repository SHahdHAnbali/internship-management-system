using Ims.Domain.Common;

namespace Ims.Domain.Mentoring;

/// <summary>
/// A periodic note an employee records during a trainee's training (PDF §4, §8: assignment, author, date, text).
/// Written by the assignment's own employee while it is active. Never deleted. Editing is not defined by the
/// requirements and is not offered (see docs/decisions.md).
/// </summary>
public sealed class ProgressNote : Entity
{
    public const int TextMaxLength = 4000;

    private ProgressNote()
    {
        Text = null!;
    }

    public Guid AssignmentId { get; private set; }

    public Guid AuthorId { get; private set; }

    public DateTimeOffset WrittenAt { get; private set; }

    public string Text { get; private set; }

    public static ProgressNote Write(Assignment assignment, Guid authorId, string text, DateTimeOffset now)
    {
        if (assignment.EmployeeId != authorId)
        {
            throw new DomainException("progress_note.not_mentor", "Only the trainee's mentor can write notes for this training.");
        }

        if (assignment.Status != AssignmentStatus.Active)
        {
            throw new DomainException("progress_note.not_active", "Notes can only be written while the training is active.");
        }

        return new ProgressNote
        {
            AssignmentId = assignment.Id,
            AuthorId = authorId,
            WrittenAt = Guard.Utc(now),
            Text = Guard.Required(text, "Note", TextMaxLength),
        };
    }
}
