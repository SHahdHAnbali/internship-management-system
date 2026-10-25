import { Directionality } from '@angular/cdk/bidi';
import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';
import { LanguageService } from './language.service';

describe('LanguageService', () => {
  let service: LanguageService;
  let document: Document;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          langs: { ar: {}, en: {} },
          translocoConfig: { availableLangs: ['ar', 'en'], defaultLang: 'ar' },
        }),
      ],
    });
    service = TestBed.inject(LanguageService);
    document = TestBed.inject(DOCUMENT);
  });

  it('defaults to Arabic, right-to-left', async () => {
    await service.init();

    expect(service.language()).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(TestBed.inject(Directionality).value).toBe('rtl');
  });

  it('switches to English, left-to-right, at runtime and remembers the choice', async () => {
    await service.init();
    await service.use('en');

    expect(service.direction()).toBe('ltr');
    expect(document.documentElement.dir).toBe('ltr');
    expect(TestBed.inject(Directionality).value).toBe('ltr');
    expect(localStorage.getItem('ims.language')).toBe('en');
  });
});
