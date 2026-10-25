import { Directionality } from '@angular/cdk/bidi';
import { DOCUMENT, Injectable, computed, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { AppLanguage, DEFAULT_LANGUAGE, LANGUAGES, isAppLanguage } from './languages';

const STORAGE_KEY = 'ims.language';

/**
 * Single source of truth for the UI language. Switching keeps Transloco, the `<html lang/dir>` attributes
 * and the CDK/Material `Directionality` (used by overlays, menus, dialogs) in sync, at runtime.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly transloco = inject(TranslocoService);
  private readonly directionality = inject(Directionality);
  private readonly document = inject(DOCUMENT);

  private readonly current = signal<AppLanguage>(DEFAULT_LANGUAGE);

  readonly language = this.current.asReadonly();
  readonly direction = computed(() => LANGUAGES[this.current()].dir);
  readonly languages = Object.values(LANGUAGES);

  /** Restores the saved language (or the default) and waits for its translations, to avoid a flash of keys. */
  async init(): Promise<void> {
    await this.use(this.readSavedLanguage() ?? DEFAULT_LANGUAGE);
  }

  async use(language: AppLanguage): Promise<void> {
    await firstValueFrom(this.transloco.load(language));
    this.transloco.setActiveLang(language);
    this.current.set(language);

    const { dir } = LANGUAGES[language];
    const html = this.document.documentElement;
    html.lang = language;
    html.dir = dir;
    if (this.directionality.value !== dir) {
      this.directionality.valueSignal.set(dir);
      this.directionality.change.emit(dir);
    }

    this.saveLanguage(language);
  }

  private readSavedLanguage(): AppLanguage | null {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return isAppLanguage(saved) ? saved : null;
    } catch {
      return null;
    }
  }

  private saveLanguage(language: AppLanguage): void {
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Storage can be unavailable (private mode, blocked site data); the choice then lasts for the session only.
    }
  }
}
