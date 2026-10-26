import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';

/** Shows translated success/error messages for Admin actions. */
@Injectable({ providedIn: 'root' })
export class AdminFeedback {
  private readonly snackBar = inject(MatSnackBar);
  private readonly transloco = inject(TranslocoService);

  saved(): void {
    this.show('admin.messages.saved');
  }

  error(error: unknown): void {
    this.show(AdminFeedback.errorKey(error));
  }

  static errorKey(error: unknown): string {
    const status = error instanceof HttpErrorResponse ? error.status : 0;
    switch (status) {
      case 400:
        return 'admin.errors.invalid';
      case 401:
        return 'admin.errors.unauthorized';
      case 403:
        return 'admin.errors.forbidden';
      case 404:
        return 'admin.errors.notFound';
      case 409:
        return 'admin.errors.conflict';
      default:
        return 'admin.errors.generic';
    }
  }

  private show(key: string): void {
    this.snackBar.open(
      this.transloco.translate(key),
      this.transloco.translate('admin.actions.close'),
      {
        duration: 4000,
      },
    );
  }
}
