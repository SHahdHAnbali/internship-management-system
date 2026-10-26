import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { adminTestingImports, adminTestingProviders } from '../testing';
import { SettingsPage } from './settings-page';

describe('SettingsPage', () => {
  function setup() {
    TestBed.configureTestingModule({
      imports: [SettingsPage, ...adminTestingImports],
      providers: adminTestingProviders,
    });
    const fixture = TestBed.createComponent(SettingsPage);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne('/api/admin/settings/notifications').flush({
      trainingEndingNoticeDays: 7,
      lateEvaluationReminderDays: 3,
      pendingRequestAlertDays: 5,
    });
    return { fixture, http, form: fixture.componentInstance['form'] };
  }

  it('loads the current intervals and saves changes', () => {
    const { fixture, http, form } = setup();
    expect(form.getRawValue()).toEqual({
      trainingEndingNoticeDays: 7,
      lateEvaluationReminderDays: 3,
      pendingRequestAlertDays: 5,
    });

    form.controls.trainingEndingNoticeDays.setValue(10);
    fixture.componentInstance['save']();

    const request = http.expectOne({ method: 'PUT', url: '/api/admin/settings/notifications' });
    expect(request.request.body).toEqual({
      trainingEndingNoticeDays: 10,
      lateEvaluationReminderDays: 3,
      pendingRequestAlertDays: 5,
    });
  });

  it('does not save intervals below one day', () => {
    const { fixture, http, form } = setup();

    form.controls.pendingRequestAlertDays.setValue(0);
    fixture.componentInstance['save']();

    http.expectNone({ method: 'PUT' });
  });
});
