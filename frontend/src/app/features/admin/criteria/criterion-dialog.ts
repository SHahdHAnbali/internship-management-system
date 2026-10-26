import { Component, inject } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslocoPipe } from '@jsverse/transloco';
import { EvaluationCriterion, SaveEvaluationCriterionRequest } from '../data/admin.models';

/** Create or edit an evaluation criterion: name, weight, order (PDF §8). */
@Component({
  selector: 'app-criterion-dialog',
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    TranslocoPipe,
  ],
  templateUrl: './criterion-dialog.html',
})
export class CriterionDialog {
  protected readonly criterion = inject<EvaluationCriterion | null>(MAT_DIALOG_DATA);
  private readonly dialogRef =
    inject<MatDialogRef<CriterionDialog, SaveEvaluationCriterionRequest>>(MatDialogRef);

  protected readonly form = inject(NonNullableFormBuilder).group({
    name: [this.criterion?.name ?? '', [Validators.required, Validators.maxLength(200)]],
    weight: [this.criterion?.weight ?? 1, [Validators.required, Validators.min(0.0001)]],
    sortOrder: [
      this.criterion?.sortOrder ?? 1,
      [Validators.required, Validators.pattern(/^-?\d+$/)],
    ],
  });

  protected save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const { name, weight, sortOrder } = this.form.getRawValue();
    this.dialogRef.close({
      name: name.trim(),
      weight: Number(weight),
      sortOrder: Number(sortOrder),
    });
  }
}
