using Ims.Domain.Common;
using Ims.Domain.Evaluations;
using Ims.Domain.Fields;
using Ims.Domain.Notifications;
using Ims.Domain.Roles;
using Ims.Domain.Staff;

namespace Ims.UnitTests.Domain;

public sealed class AdminDomainTests
{
    [Fact]
    public void A_new_staff_account_gets_the_Employee_role()
    {
        var employee = Employee.CreateOnFirstSignIn("  New.Hire@Company.com ", "New Hire");

        Assert.Equal(UserRole.Employee, employee.Role);
        Assert.Equal("new.hire@company.com", employee.Email);
    }

    [Theory]
    [InlineData(UserRole.HR)]
    [InlineData(UserRole.Admin)]
    [InlineData(UserRole.Employee)]
    public void Admin_can_grant_any_staff_role(UserRole role)
    {
        var employee = Employee.CreateOnFirstSignIn("a@company.com", "A");

        employee.ChangeRole(role);

        Assert.Equal(role, employee.Role);
    }

    [Fact]
    public void A_staff_member_cannot_be_given_the_Trainee_role()
    {
        var employee = Employee.CreateOnFirstSignIn("a@company.com", "A");

        var error = Assert.Throws<DomainException>(() => employee.ChangeRole(UserRole.Trainee));

        Assert.Equal("employee.invalid_role", error.Code);
        Assert.Equal(UserRole.Employee, employee.Role);
    }

    [Fact]
    public void Fields_start_active_and_can_be_edited_and_deactivated()
    {
        var field = Field.Create(" Backend ", "APIs");
        Assert.True(field.IsActive);
        Assert.Equal("Backend", field.Name);

        field.Update("Backend & APIs", null, isActive: false);

        Assert.Equal("Backend & APIs", field.Name);
        Assert.Null(field.Description);
        Assert.False(field.IsActive);
    }

    [Fact]
    public void A_field_needs_a_name()
    {
        Assert.Throws<DomainException>(() => Field.Create("  ", null));
    }

    [Fact]
    public void A_new_criterion_has_both_names_is_active_and_gets_its_order_from_the_database()
    {
        var criterion = EvaluationCriterion.Create(" العمل الجماعي ", " Teamwork ");

        // 0 until saved: the database assigns the next order (migration EvaluationCriteriaAutomaticOrder).
        Assert.Equal(("العمل الجماعي", "Teamwork", 0, true), (criterion.NameAr, criterion.NameEn, criterion.SortOrder, criterion.IsActive));
    }

    [Fact]
    public void A_criterion_update_changes_names_and_active_flag_never_its_order()
    {
        var criterion = EvaluationCriterion.Create("العمل الجماعي", "Teamwork");

        criterion.Update("التواصل", "Communication", isActive: false);

        Assert.Equal(("التواصل", "Communication", 0, false), (criterion.NameAr, criterion.NameEn, criterion.SortOrder, criterion.IsActive));
    }

    [Theory]
    [InlineData("  ", "Teamwork")]
    [InlineData("العمل الجماعي", "")]
    public void A_criterion_needs_an_arabic_and_an_english_name(string nameAr, string nameEn)
    {
        var error = Assert.Throws<DomainException>(() => EvaluationCriterion.Create(nameAr, nameEn));

        Assert.Equal("validation.required", error.Code);
    }

    [Fact]
    public void A_criterion_name_is_at_most_200_characters()
    {
        Assert.Throws<DomainException>(() => EvaluationCriterion.Create(new string('a', 201), "Teamwork"));
        Assert.Throws<DomainException>(() => EvaluationCriterion.Create("العمل الجماعي", new string('a', 201)));
    }

    [Fact]
    public void Notification_settings_default_to_the_pdf_values()
    {
        var settings = NotificationSettings.Defaults();

        Assert.Equal((7, 3, 5), (settings.TrainingEndingNoticeDays, settings.LateEvaluationReminderDays, settings.PendingRequestAlertDays));
    }

    [Fact]
    public void Notification_intervals_must_be_at_least_one_day()
    {
        var settings = NotificationSettings.Defaults();

        Assert.Throws<DomainException>(() => settings.Update(0, 3, 5));
        Assert.Throws<DomainException>(() => settings.Update(10, 0, 5));
        Assert.Equal((7, 3, 5), (settings.TrainingEndingNoticeDays, settings.LateEvaluationReminderDays, settings.PendingRequestAlertDays));
    }
}
