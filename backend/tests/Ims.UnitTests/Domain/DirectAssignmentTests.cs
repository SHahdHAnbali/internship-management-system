using Ims.Domain.Common;
using Ims.Domain.Mentoring;

namespace Ims.UnitTests.Domain;

/// <summary>AD-67: HR's direct assignment and the automatic rejection of the trainee's pending mentor requests.</summary>
public sealed class DirectAssignmentTests
{
    private static readonly DateTimeOffset Now = new(2027, 1, 5, 9, 0, 0, TimeSpan.Zero);
    private static readonly Guid Hr = Guid.CreateVersion7();

    [Fact]
    public void AssignDirectly_creates_an_Active_assignment_without_a_request_and_checks_the_period()
    {
        var applicationId = Guid.CreateVersion7();
        var mentor = Guid.CreateVersion7();

        var assignment = Assignment.AssignDirectly(applicationId, mentor, new DateOnly(2027, 1, 10), new DateOnly(2027, 1, 10), Now);

        Assert.Equal(AssignmentStatus.Active, assignment.Status);
        Assert.Null(assignment.MentorRequestId);
        Assert.Equal((applicationId, mentor), (assignment.ApplicationId, assignment.EmployeeId));
        Assert.Equal(new DateOnly(2027, 1, 10), assignment.EndDate);
        Assert.Equal(
            "assignment.invalid_period",
            Assert.Throws<DomainException>(() => Assignment.AssignDirectly(applicationId, mentor, new DateOnly(2027, 2, 1), new DateOnly(2027, 1, 31), Now)).Code);
    }

    [Fact]
    public void RejectBecauseDirectlyAssigned_rejects_a_pending_request_once_and_keeps_the_reason()
    {
        var request = MentorRequest.Create(Guid.CreateVersion7(), Guid.CreateVersion7(), "I can train them", Now);

        Assert.Throws<DomainException>(() => request.RejectBecauseDirectlyAssigned(Hr, "  ", Now));
        Assert.Equal(MentorRequestStatus.Pending, request.Status);

        request.RejectBecauseDirectlyAssigned(Hr, " HR assigned the trainee directly. ", Now);
        Assert.Equal(MentorRequestStatus.Rejected, request.Status);
        Assert.Equal((Hr, Now, "HR assigned the trainee directly."), (request.DecidedById!.Value, request.DecidedAt!.Value, request.RejectionReason!));
        Assert.Equal(
            "mentor_request.invalid_status",
            Assert.Throws<DomainException>(() => request.RejectBecauseDirectlyAssigned(Hr, "Again", Now)).Code);
        Assert.Throws<DomainException>(() => request.Approve(Hr, new DateOnly(2027, 1, 10), new DateOnly(2027, 2, 1), Now));
    }
}
