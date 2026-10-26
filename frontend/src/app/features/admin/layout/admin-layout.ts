import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { LanguageService } from '../../../core/i18n/language.service';

/** Shell of the Admin area: one tab per Admin responsibility (PDF §4) plus the AR/EN switch. */
@Component({
  selector: 'app-admin-layout',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatTabsModule,
    MatButtonModule,
    TranslocoPipe,
  ],
  templateUrl: './admin-layout.html',
  styleUrl: './admin-layout.scss',
})
export class AdminLayout {
  protected readonly language = inject(LanguageService);

  protected readonly links = [
    { path: 'fields', label: 'admin.nav.fields' },
    { path: 'evaluation-criteria', label: 'admin.nav.criteria' },
    { path: 'users', label: 'admin.nav.users' },
    { path: 'settings', label: 'admin.nav.settings' },
  ];
}
