import { Component, OnInit, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTableModule } from '@angular/material/table';
import { TranslocoPipe } from '@jsverse/transloco';
import { filter, switchMap } from 'rxjs';
import { AdminApi } from '../data/admin-api';
import { AdminFeedback } from '../data/admin-feedback';
import { EvaluationCriterion } from '../data/admin.models';
import { CriterionDialog } from './criterion-dialog';

/** Admin: manage the evaluation criteria and their weights (PDF §4, §8). */
@Component({
  selector: 'app-criteria-page',
  imports: [MatTableModule, MatButtonModule, MatProgressBarModule, TranslocoPipe],
  templateUrl: './criteria-page.html',
})
export class CriteriaPage implements OnInit {
  private readonly api = inject(AdminApi);
  private readonly dialog = inject(MatDialog);
  private readonly feedback = inject(AdminFeedback);

  protected readonly criteria = signal<EvaluationCriterion[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly columns = ['order', 'name', 'weight', 'actions'];

  ngOnInit(): void {
    this.load();
  }

  protected add(): void {
    this.openDialog(null)
      .pipe(switchMap((value) => this.api.createCriterion(value)))
      .subscribe({ next: () => this.done(), error: (e) => this.feedback.error(e) });
  }

  protected edit(criterion: EvaluationCriterion): void {
    this.openDialog(criterion)
      .pipe(switchMap((value) => this.api.updateCriterion(criterion.id, value)))
      .subscribe({ next: () => this.done(), error: (e) => this.feedback.error(e) });
  }

  private openDialog(criterion: EvaluationCriterion | null) {
    return this.dialog
      .open(CriterionDialog, { data: criterion, width: '480px', maxWidth: '95vw' })
      .afterClosed()
      .pipe(filter((value) => !!value));
  }

  private done(): void {
    this.feedback.saved();
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api.listCriteria().subscribe({
      next: (criteria) => {
        this.criteria.set(criteria);
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
