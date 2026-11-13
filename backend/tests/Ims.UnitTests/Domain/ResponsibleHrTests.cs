using Ims.Domain.Applications;
using Ims.Domain.Common;

namespace Ims.UnitTests.Domain;

/// <summary>AD-64: the accepting HR stays recorded; an Admin appoints replacements on accepted applications only.</summary>
public sealed class ResponsibleHrTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 13, 9, 0, 0, TimeSpan.Zero);
    private static readonly Guid HrA = Guid.CreateVersion7();
    private static readonly Guid HrB = Guid.CreateVersion7();
    private static readonly Guid Admin = Guid.CreateVersion7();

    private static TrainingApplication Submit() => TrainingApplication.Submit(
        Guid.CreateVersion7(), Guid.CreateVersion7(), new DateOnly(2027, 1, 1), new DateOnly(2027, 3, 31), 240, true, Now);

    [Fact]
    public void AppointResponsibleHr_accepted_application_records_the_change_and_keeps_the_accepting_hr()
    {
        var application = Submit();
        application.Accept(HrA, Now);

        var change = application.AppointResponsibleHr(1, HrB, Admin, Now.AddDays(3));

        Assert.Equal(application.Id, change.ApplicationId);
        Assert.Equal(1, change.Sequence);
        Assert.Equal(HrB, change.HrId);
        Assert.Equal(Admin, change.ChangedById);
        Assert.Equal(Now.AddDays(3), change.ChangedAt);
        Assert.Equal(HrA, application.DecidedById); // the original accepting HR is never overwritten
    }

    [Fact]
    public void AppointResponsibleHr_not_accepted_or_invalid_input_throws()
    {
        var submitted = Submit();
        Assert.Throws<DomainException>(() => submitted.AppointResponsibleHr(1, HrB, Admin, Now));

        var rejected = Submit();
        rejected.Reject(HrA, "Not available.", Now);
        Assert.Throws<DomainException>(() => rejected.AppointResponsibleHr(1, HrB, Admin, Now));

        var accepted = Submit();
        accepted.Accept(HrA, Now);
        Assert.Throws<DomainException>(() => accepted.AppointResponsibleHr(0, HrB, Admin, Now));
        Assert.Throws<DomainException>(() => accepted.AppointResponsibleHr(1, Guid.Empty, Admin, Now));
        Assert.Throws<DomainException>(() => accepted.AppointResponsibleHr(1, HrB, Guid.Empty, Now));
        Assert.Throws<DomainException>(() => accepted.AppointResponsibleHr(1, HrB, Admin, new DateTimeOffset(2026, 11, 13, 9, 0, 0, TimeSpan.FromHours(2))));
    }
}
