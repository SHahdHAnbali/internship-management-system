import { Component, OnInit, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslocoPipe } from '@jsverse/transloco';
import { AdminApi } from '../data/admin-api';
import { AdminFeedback } from '../data/admin-feedback';

const days = [
  Validators.required,
  Validators.min(1),
  Validators.max(365),
  Validators.pattern(/^\d+$/),
];

/** Admin: the notification intervals (PDF §7: 7 days, 3 days, 5 days are settings the Admin changes). */
@Component({
  selector: 'app-settings-page',
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatProgressBarModule,
    TranslocoPipe,
  ],
  templateUrl: './settings-page.html',
})
export class SettingsPage implements OnInit {
  private readonly api = inject(AdminApi);
  private readonly feedback = inject(AdminFeedback);

  protected readonly settings = [
    {
      control: 'trainingEndingNoticeDays',
      label: 'admin.settings.trainingEndingNoticeDays',
      hint: 'admin.settings.trainingEndingNoticeHint',
    },
    {
      control: 'lateEvaluationReminderDays',
      label: 'admin.settings.lateEvaluationReminderDays',
      hint: 'admin.settings.lateEvaluationReminderHint',
    },
    {
      control: 'pendingRequestAlertDays',
      label: 'admin.settings.pendingRequestAlertDays',
      hint: 'admin.settings.pendingRequestAlertHint',
    },
  ] as const;
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly form = inject(NonNullableFormBuilder).group({
    trainingEndingNoticeDays: [7, days],
    lateEvaluationReminderDays: [3, days],
    pendingRequestAlertDays: [5, days],
  });

  ngOnInit(): void {
    this.api.getNotificationSettings().subscribe({
      next: (settings) => {
        this.form.setValue(settings);
        this.loading.set(false);
      },
      error: (e) => {
        this.loading.set(false);
        this.form.disable();
        this.feedback.error(e);
      },
    });
  }

  protected save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    this.saving.set(true);
    this.api
      .updateNotificationSettings({
        trainingEndingNoticeDays: Number(value.trainingEndingNoticeDays),
        lateEvaluationReminderDays: Number(value.lateEvaluationReminderDays),
        pendingRequestAlertDays: Number(value.pendingRequestAlertDays),
      })
      .subscribe({
        next: (saved) => {
          this.form.setValue(saved);
          this.saving.set(false);
          this.feedback.saved();
        },
        error: (e) => {
          this.saving.set(false);
          this.feedback.error(e);
        },
      });
  }
}
