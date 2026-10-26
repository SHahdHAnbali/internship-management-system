import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';

/** Common TestBed setup for Admin specs: HTTP testing backend and Transloco with real keys echoed back. */
export const adminTestingImports = [
  TranslocoTestingModule.forRoot({
    langs: { ar: {} },
    translocoConfig: { availableLangs: ['ar'], defaultLang: 'ar' },
  }),
];

export const adminTestingProviders = [provideHttpClient(), provideHttpClientTesting()];
