import { Component, OnInit, inject, signal } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { TranslocoPipe } from '@jsverse/transloco';
import { AdminApi } from '../data/admin-api';
import { AdminFeedback } from '../data/admin-feedback';
import { STAFF_ROLES, User, UserRole } from '../data/admin.models';

/**
 * Admin: users and their roles (PDF §2, §4). Staff accounts are created as Employee on first Google sign-in;
 * the Admin grants higher roles here.
 */
@Component({
  selector: 'app-users-page',
  imports: [
    MatTableModule,
    MatFormFieldModule,
    MatSelectModule,
    MatProgressBarModule,
    TranslocoPipe,
  ],
  templateUrl: './users-page.html',
})
export class UsersPage implements OnInit {
  private readonly api = inject(AdminApi);
  private readonly feedback = inject(AdminFeedback);

  protected readonly users = signal<User[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly roles = STAFF_ROLES;
  protected readonly columns = ['name', 'email', 'department', 'role'];

  ngOnInit(): void {
    this.load();
  }

  protected changeRole(user: User, role: UserRole): void {
    this.api.changeUserRole(user.id, role).subscribe({
      next: (updated) => {
        this.users.update((users) => users.map((u) => (u.id === updated.id ? updated : u)));
        this.feedback.saved();
      },
      error: (e) => {
        this.feedback.error(e);
        this.load();
      },
    });
  }

  private load(): void {
    this.loading.set(true);
    this.api.listUsers().subscribe({
      next: (users) => {
        this.users.set(users);
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
