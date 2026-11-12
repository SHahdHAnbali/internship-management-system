using Ims.Domain.Applications;
using Ims.Domain.Common;
using Ims.Domain.Mentoring;
using Ims.Domain.Trainees;

namespace Ims.UnitTests.Domain;

public sealed class TrainingLifecycleTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 29, 9, 0, 0, TimeSpan.Zero);
    private static readonly Guid Hr = Guid.CreateVersion7();
    private static readonly Guid Employee = Guid.CreateVersion7();

    private static TrainingApplication Submit() => TrainingApplication.Submit(
        Guid.CreateVersion7(), Guid.CreateVersion7(), new DateOnly(2027, 1, 1), new DateOnly(2027, 3, 31), 240, true, Now);

    [Fact]
    public void An_application_is_submitted_then_reviewed_then_accepted()
    {
        var application = Submit();
        Assert.Equal(ApplicationStatus.Submitted, application.Status);

        application.MarkUnderReview();
        application.Accept(Hr, Now.AddDays(1));

        Assert.Equal(ApplicationStatus.Accepted, application.Status);
        Assert.Equal(Hr, application.DecidedById);
        Assert.Null(application.RejectionReason);
    }

    [Fact]
    public void HR_may_decide_from_submitted_and_a_rejection_needs_a_reason()
    {
        var application = Submit();
        Assert.Throws<DomainException>(() => application.Reject(Hr, " ", Now));

        application.Reject(Hr, "The requested period is not available.", Now);
        Assert.Equal(ApplicationStatus.Rejected, application.Status);
        Assert.Equal("The requested period is not available.", application.RejectionReason);
    }

    [Fact]
    public void Decisions_are_final_and_review_only_follows_submission()
    {
        var accepted = Submit();
        accepted.Accept(Hr, Now);
        Assert.Throws<DomainException>(() => accepted.Reject(Hr, "Changed my mind", Now));
        Assert.Throws<DomainException>(() => accepted.MarkUnderReview());

        var reviewed = Submit();
        reviewed.MarkUnderReview();
        Assert.Throws<DomainException>(() => reviewed.MarkUnderReview());
    }

    [Fact]
    public void An_application_needs_a_valid_period_and_positive_hours()
    {
        Assert.Throws<DomainException>(() => TrainingApplication.Submit(
            Guid.CreateVersion7(), Guid.CreateVersion7(), new DateOnly(2027, 3, 1), new DateOnly(2027, 2, 1), 10, false, Now));
        Assert.Throws<DomainException>(() => TrainingApplication.Submit(
            Guid.CreateVersion7(), Guid.CreateVersion7(), new DateOnly(2027, 3, 1), new DateOnly(2027, 3, 1), 0, false, Now));
    }

    [Fact]
    public void An_approved_mentor_request_starts_an_active_assignment_with_HRs_dates()
    {
        var request = MentorRequest.Create(Employee, Guid.CreateVersion7(), "Build the reporting API", Now);
        Assert.Equal(MentorRequestStatus.Pending, request.Status);

        var assignment = request.Approve(Hr, new DateOnly(2027, 1, 3), new DateOnly(2027, 3, 31), Now);

        Assert.Equal(MentorRequestStatus.Approved, request.Status);
        Assert.Equal(AssignmentStatus.Active, assignment.Status);
        Assert.Equal(Employee, assignment.EmployeeId);
        Assert.Equal(request.Id, assignment.MentorRequestId);
        Assert.Throws<DomainException>(() => request.Reject(Hr, Now)); // already decided
    }

    [Fact]
    public void A_mentor_request_needs_a_note_and_an_assignment_a_valid_period()
    {
        Assert.Throws<DomainException>(() => MentorRequest.Create(Employee, Guid.CreateVersion7(), "", Now));
        var request = MentorRequest.Create(Employee, Guid.CreateVersion7(), "Testing", Now);
        Assert.Throws<DomainException>(() => request.Approve(Hr, new DateOnly(2027, 3, 1), new DateOnly(2027, 2, 1), Now));
        Assert.Equal(MentorRequestStatus.Pending, request.Status);
    }

    [Fact]
    public void Only_the_mentor_writes_notes_and_only_while_the_training_is_active()
    {
        var assignment = MentorRequest.Create(Employee, Guid.CreateVersion7(), "Testing", Now)
            .Approve(Hr, new DateOnly(2027, 1, 3), new DateOnly(2027, 3, 31), Now);

        var note = ProgressNote.Write(assignment, Employee, "Finished the onboarding tasks.", Now);
        Assert.Equal(assignment.Id, note.AssignmentId);
        Assert.Throws<DomainException>(() => ProgressNote.Write(assignment, Guid.CreateVersion7(), "Not my trainee", Now));
        Assert.Throws<DomainException>(() => ProgressNote.Write(assignment, Employee, " ", Now));
    }

    [Fact]
    public void A_trainee_profile_is_recorded_once_and_never_overwritten()
    {
        var trainee = Trainee.Register("lina@trainee.example");
        Assert.False(trainee.HasProfile);

        Assert.True(trainee.RecordProfile("Lina Haddad", "000", "Example University", "CE", "Fourth year"));
        Assert.False(trainee.RecordProfile("Someone Else", "111", "Other", "CS", "First year"));

        Assert.Equal("Lina Haddad", trainee.FullName);
        Assert.Equal("Example University", trainee.University);
    }

    [Fact]
    public void A_contact_log_entry_records_the_documented_fields()
    {
        var entry = ContactLog.Record(Guid.CreateVersion7(), Hr, new DateOnly(2026, 10, 29), ContactMethod.Phone, "Agreed on the period.", Now);

        Assert.Equal(ContactMethod.Phone, entry.Method);
        Assert.Equal(new DateOnly(2026, 10, 29), entry.ContactDate);
        Assert.Throws<DomainException>(() => ContactLog.Record(Guid.CreateVersion7(), Hr, new DateOnly(2026, 10, 29), ContactMethod.Email, " ", Now));
        Assert.Throws<DomainException>(() => ContactLog.Record(Guid.CreateVersion7(), Hr, new DateOnly(2026, 10, 29), (ContactMethod)9, "x", Now));
    }

    [Fact]
    public void Extend_active_training_later_date_records_previous_and_new_end_date()
    {
        var assignment = MentorRequest.Create(Employee, Guid.CreateVersion7(), "Work", Now)
            .Approve(Hr, new DateOnly(2027, 1, 3), new DateOnly(2027, 3, 31), Now);

        var first = assignment.Extend(new DateOnly(2027, 4, 30), " Project not finished ", Hr, Now.AddDays(1));
        var second = assignment.Extend(new DateOnly(2027, 5, 15), "Still testing", Hr, Now.AddDays(2));

        Assert.Equal(new DateOnly(2027, 5, 15), assignment.EndDate);
        Assert.Equal((new DateOnly(2027, 3, 31), new DateOnly(2027, 4, 30)), (first.PreviousEndDate, first.NewEndDate));
        Assert.Equal((new DateOnly(2027, 4, 30), new DateOnly(2027, 5, 15)), (second.PreviousEndDate, second.NewEndDate));
        Assert.Equal("Project not finished", first.Reason);
        Assert.Equal(assignment.Id, second.AssignmentId);
        Assert.Equal(Hr, second.ExtendedById);
        Assert.Equal(AssignmentStatus.Active, assignment.Status);
    }

    [Fact]
    public void Extend_same_or_earlier_date_or_missing_reason_throws_and_changes_nothing()
    {
        var assignment = MentorRequest.Create(Employee, Guid.CreateVersion7(), "Work", Now)
            .Approve(Hr, new DateOnly(2027, 1, 3), new DateOnly(2027, 3, 31), Now);

        Assert.Equal("assignment.extension_not_later",
            Assert.Throws<DomainException>(() => assignment.Extend(new DateOnly(2027, 3, 31), "x", Hr, Now)).Code);
        Assert.Throws<DomainException>(() => assignment.Extend(new DateOnly(2027, 3, 1), "x", Hr, Now));
        Assert.Throws<DomainException>(() => assignment.Extend(new DateOnly(2027, 4, 30), "  ", Hr, Now));
        Assert.Equal(new DateOnly(2027, 3, 31), assignment.EndDate);
    }
}
