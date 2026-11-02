using Ims.Domain.Common;

namespace Ims.Domain.Trainees;

/// <summary>
/// A trainee account (PDF §2, §8). Trainees register and sign in with their e-mail only (passwordless).
/// The profile (PDF §8: name, phone, university, major, study year) is entered on the application form (PDF §4).
/// It is recorded by the first application and never overwritten by later ones; how a profile may change afterwards
/// is not defined yet (see docs/decisions.md).
/// </summary>
public sealed class Trainee : Entity
{
    public const int NameMaxLength = 200;
    public const int PhoneMaxLength = 50;
    public const int UniversityMaxLength = 200;
    public const int MajorMaxLength = 200;
    public const int StudyYearMaxLength = 50;

    private Trainee()
    {
        Email = null!;
    }

    public string Email { get; private set; }

    public string? FullName { get; private set; }

    public string? Phone { get; private set; }

    public string? University { get; private set; }

    public string? Major { get; private set; }

    public string? StudyYear { get; private set; }

    public bool HasProfile => FullName is not null;

    /// <summary>
    /// Records the profile given on the trainee's first application form. Returns false, changing nothing, when a
    /// profile is already recorded.
    /// </summary>
    public bool RecordProfile(string fullName, string phone, string university, string major, string studyYear)
    {
        if (HasProfile)
        {
            return false;
        }

        FullName = Guard.Required(fullName, "Name", NameMaxLength);
        Phone = Guard.Required(phone, "Phone", PhoneMaxLength);
        University = Guard.Required(university, "University", UniversityMaxLength);
        Major = Guard.Required(major, "Major", MajorMaxLength);
        StudyYear = Guard.Required(studyYear, "Study year", StudyYearMaxLength);
        return true;
    }

    /// <summary>First successful e-mail verification creates the account (PDF §4: "registration and sign-in by e-mail only").</summary>
    public static Trainee Register(string email) => new() { Email = EmailAddress.Normalize(email) };
}
