import { Component, inject } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslocoPipe } from '@jsverse/transloco';
import { CreateFieldRequest, Field } from '../data/admin.models';

/** Create or edit a field's name and description. Returns the form value, or nothing when cancelled. */
@Component({
  selector: 'app-field-dialog',
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    TranslocoPipe,
  ],
  templateUrl: './field-dialog.html',
})
export class FieldDialog {
  protected readonly field = inject<Field | null>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject<MatDialogRef<FieldDialog, CreateFieldRequest>>(MatDialogRef);

  protected readonly form = inject(NonNullableFormBuilder).group({
    name: [this.field?.name ?? '', [Validators.required, Validators.maxLength(100)]],
    description: [this.field?.description ?? '', [Validators.maxLength(1000)]],
  });

  protected save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const { name, description } = this.form.getRawValue();
    this.dialogRef.close({ name: name.trim(), description: description.trim() || null });
  }
}
