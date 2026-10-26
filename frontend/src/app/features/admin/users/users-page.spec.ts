import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { adminTestingImports, adminTestingProviders } from '../testing';
import { UsersPage } from './users-page';

describe('UsersPage', () => {
  it('lists staff and offers only the staff roles', async () => {
    TestBed.configureTestingModule({
      imports: [UsersPage, ...adminTestingImports],
      providers: adminTestingProviders,
    });
    const fixture = TestBed.createComponent(UsersPage);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    http.expectOne('/api/admin/users').flush([
      {
        id: 'u1',
        fullName: 'Sara',
        email: 'sara@company.com',
        department: null,
        role: 'Employee',
      },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('sara@company.com');
    expect(fixture.componentInstance['roles']).toEqual(['Employee', 'HR', 'Admin']);
  });

  it('sends a role change to the API', () => {
    TestBed.configureTestingModule({
      imports: [UsersPage, ...adminTestingImports],
      providers: adminTestingProviders,
    });
    const fixture = TestBed.createComponent(UsersPage);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    const user = {
      id: 'u1',
      fullName: 'Sara',
      email: 'sara@company.com',
      department: null,
      role: 'Employee' as const,
    };
    http.expectOne('/api/admin/users').flush([user]);

    fixture.componentInstance['changeRole'](user, 'HR');

    const request = http.expectOne({ method: 'PUT', url: '/api/admin/users/u1/role' });
    expect(request.request.body).toEqual({ role: 'HR' });
    request.flush({ ...user, role: 'HR' });
    expect(fixture.componentInstance['users']()[0].role).toBe('HR');
  });
});
