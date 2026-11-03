import { apiRequest } from '../lib/api';
import type { ReportArea } from './monthlyReportApi';

export interface FieldsReportRow {
  field: { id: string; name: string };
  /** Every application in the field, whatever its status (a trainee with two applications counts twice). */
  applications: number;
  /** Applications whose status is Accepted. */
  accepted: number;
}

export interface FieldsReport {
  rows: FieldsReportRow[];
}

/** `/api/hr/reports/fields` or `/api/admin/reports/fields`: the same read-only report; `fieldId` keeps one field. */
export const fieldsReportApi = {
  report: (area: ReportArea, fieldId = '') =>
    apiRequest<FieldsReport>(
      'GET',
      `/${area}/reports/fields${fieldId ? `?${new URLSearchParams({ fieldId })}` : ''}`,
    ),
};
