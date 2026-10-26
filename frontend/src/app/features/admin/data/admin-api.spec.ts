import { HttpErrorResponse } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { adminTestingProviders } from '../testing';
import { AdminApi } from './admin-api';
import { AdminFeedback } from './admin-feedback';

describe('AdminApi', () => {
  let api: AdminApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: adminTestingProviders });
    api = TestBed.inject(AdminApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('calls the admin field endpoints', () => {
    api.listFields().subscribe();
    api.createField({ name: 'QA', description: null }).subscribe();
    api.updateField('f1', { name: 'QA', description: null, isActive: false }).subscribe();

    expect(http.expectOne({ method: 'GET', url: '/api/admin/fields' })).toBeTruthy();
    expect(http.expectOne({ method: 'POST', url: '/api/admin/fields' }).request.body).toEqual({
      name: 'QA',
      description: null,
    });
    expect(
      http.expectOne({ method: 'PUT', url: '/api/admin/fields/f1' }).request.body.isActive,
    ).toBe(false);
  });

  it('calls the evaluation criteria endpoints', () => {
    api.listCriteria().subscribe();
    api.createCriterion({ name: 'Teamwork', weight: 2, sortOrder: 1 }).subscribe();
    api.updateCriterion('c1', { name: 'Teamwork', weight: 3, sortOrder: 1 }).subscribe();

    http.expectOne({ method: 'GET', url: '/api/admin/evaluation-criteria' });
    http.expectOne({ method: 'POST', url: '/api/admin/evaluation-criteria' });
    expect(
      http.expectOne({ method: 'PUT', url: '/api/admin/evaluation-criteria/c1' }).request.body
        .weight,
    ).toBe(3);
  });

  it('calls the user role and settings endpoints', () => {
    api.listUsers().subscribe();
    api.changeUserRole('u1', 'HR').subscribe();
    api.getNotificationSettings().subscribe();
    api
      .updateNotificationSettings({
        trainingEndingNoticeDays: 7,
        lateEvaluationReminderDays: 3,
        pendingRequestAlertDays: 5,
      })
      .subscribe();

    http.expectOne({ method: 'GET', url: '/api/admin/users' });
    expect(http.expectOne({ method: 'PUT', url: '/api/admin/users/u1/role' }).request.body).toEqual(
      { role: 'HR' },
    );
    http.expectOne({ method: 'GET', url: '/api/admin/settings/notifications' });
    http.expectOne({ method: 'PUT', url: '/api/admin/settings/notifications' });
  });
});

describe('AdminFeedback.errorKey', () => {
  it.each([
    [400, 'admin.errors.invalid'],
    [401, 'admin.errors.unauthorized'],
    [403, 'admin.errors.forbidden'],
    [404, 'admin.errors.notFound'],
    [409, 'admin.errors.conflict'],
    [500, 'admin.errors.generic'],
  ])('maps HTTP %i to %s', (status, key) => {
    expect(AdminFeedback.errorKey(new HttpErrorResponse({ status }))).toBe(key);
  });
});
