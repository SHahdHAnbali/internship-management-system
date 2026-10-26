import { Component, OnInit, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { TranslocoPipe } from '@jsverse/transloco';
import { filter, switchMap } from 'rxjs';
import { AdminApi } from '../data/admin-api';
import { AdminFeedback } from '../data/admin-feedback';
import { Field } from '../data/admin.models';
import { FieldDialog } from './field-dialog';

/** Admin: manage training fields — add, edit, activate/deactivate (PDF §4, §8). */
@Component({
  selector: 'app-fields-page',
  imports: [
    MatTableModule,
    MatButtonModule,
    MatSlideToggleModule,
    MatProgressBarModule,
    TranslocoPipe,
  ],
  templateUrl: './fields-page.html',
})
export class FieldsPage implements OnInit {
  private readonly api = inject(AdminApi);
  private readonly dialog = inject(MatDialog);
  private readonly feedback = inject(AdminFeedback);

  protected readonly fields = signal<Field[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly columns = ['name', 'description', 'active', 'actions'];

  ngOnInit(): void {
    this.load();
  }

  protected add(): void {
    this.openDialog(null)
      .pipe(switchMap((value) => this.api.createField(value)))
      .subscribe({ next: () => this.done(), error: (e) => this.feedback.error(e) });
  }

  protected edit(field: Field): void {
    this.openDialog(field)
      .pipe(
        switchMap((value) =>
          this.api.updateField(field.id, { ...value, isActive: field.isActive }),
        ),
      )
      .subscribe({ next: () => this.done(), error: (e) => this.feedback.error(e) });
  }

  protected setActive(field: Field, isActive: boolean): void {
    this.api
      .updateField(field.id, { name: field.name, description: field.description, isActive })
      .subscribe({
        next: () => this.done(),
        error: (e) => {
          this.feedback.error(e);
          this.load();
        },
      });
  }

  private openDialog(field: Field | null) {
    return this.dialog
      .open(FieldDialog, { data: field, width: '480px', maxWidth: '95vw' })
      .afterClosed()
      .pipe(filter((value) => !!value));
  }

  private done(): void {
    this.feedback.saved();
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api.listFields().subscribe({
      next: (fields) => {
        this.fields.set(fields);
        this.loadFailed.set(false);
        this.loading.set(false);
      },
      error: (e) => {
        this.loadFailed.set(true);
        this.loading.set(false);
        this.feedback.error(e);
      },
    });
  }
}
