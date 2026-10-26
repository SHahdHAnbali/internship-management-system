import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../../../environments/environment';
import {
  CreateFieldRequest,
  EvaluationCriterion,
  Field,
  NotificationSettings,
  SaveEvaluationCriterionRequest,
  UpdateFieldRequest,
  User,
  UserRole,
} from './admin.models';

/** HTTP client for the Admin API (`/api/admin/...`, Admin role only). */
@Injectable({ providedIn: 'root' })
export class AdminApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/admin`;

  listFields() {
    return this.http.get<Field[]>(`${this.baseUrl}/fields`);
  }

  createField(request: CreateFieldRequest) {
    return this.http.post<Field>(`${this.baseUrl}/fields`, request);
  }

  updateField(id: string, request: UpdateFieldRequest) {
    return this.http.put<Field>(`${this.baseUrl}/fields/${id}`, request);
  }

  listCriteria() {
    return this.http.get<EvaluationCriterion[]>(`${this.baseUrl}/evaluation-criteria`);
  }

  createCriterion(request: SaveEvaluationCriterionRequest) {
    return this.http.post<EvaluationCriterion>(`${this.baseUrl}/evaluation-criteria`, request);
  }

  updateCriterion(id: string, request: SaveEvaluationCriterionRequest) {
    return this.http.put<EvaluationCriterion>(`${this.baseUrl}/evaluation-criteria/${id}`, request);
  }

  listUsers() {
    return this.http.get<User[]>(`${this.baseUrl}/users`);
  }

  changeUserRole(id: string, role: UserRole) {
    return this.http.put<User>(`${this.baseUrl}/users/${id}/role`, { role });
  }

  getNotificationSettings() {
    return this.http.get<NotificationSettings>(`${this.baseUrl}/settings/notifications`);
  }

  updateNotificationSettings(settings: NotificationSettings) {
    return this.http.put<NotificationSettings>(`${this.baseUrl}/settings/notifications`, settings);
  }
}
