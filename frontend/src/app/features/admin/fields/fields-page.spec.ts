import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { adminTestingImports, adminTestingProviders } from '../testing';
import { FieldsPage } from './fields-page';

describe('FieldsPage', () => {
  it('lists the fields from the API', async () => {
    TestBed.configureTestingModule({
      imports: [FieldsPage, ...adminTestingImports],
      providers: adminTestingProviders,
    });
    const fixture = TestBed.createComponent(FieldsPage);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    http.expectOne('/api/admin/fields').flush([
      { id: '1', name: 'Backend', description: 'APIs', isActive: true },
      { id: '2', name: 'QA', description: null, isActive: false },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('tr.mat-mdc-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Backend');
  });

  it('toggles a field active state through the API', async () => {
    TestBed.configureTestingModule({
      imports: [FieldsPage, ...adminTestingImports],
      providers: adminTestingProviders,
    });
    const fixture = TestBed.createComponent(FieldsPage);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http
      .expectOne('/api/admin/fields')
      .flush([{ id: '1', name: 'Backend', description: null, isActive: true }]);
    await fixture.whenStable();
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('mat-slide-toggle button')!
      .click();

    const request = http.expectOne({ method: 'PUT', url: '/api/admin/fields/1' });
    expect(request.request.body).toEqual({ name: 'Backend', description: null, isActive: false });
  });
});
