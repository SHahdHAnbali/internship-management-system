import { apiRequest } from '../lib/api';

/** The areas the monthly report is given to (PDF §6: HR and the Admin), each with its own API route. */
export type ReportArea = 'hr' | 'admin';

export interface MonthlyReportRow {
  assignmentId: string;
  traineeName: string | null;
  employee: { id: string; fullName: string };
  field: { id: string; name: string };
  /** Recorded dates, `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
}

export interface MonthlyReport {
  /** `YYYY-MM`. */
  month: string;
  monthStart: string;
  monthEnd: string;
  rows: MonthlyReportRow[];
}

export interface MonthlyReportFilters {
  fields: { id: string; name: string }[];
  employees: { id: string; fullName: string }[];
}

export interface MonthlyReportQuery {
  month: string;
  fieldId: string;
  employeeId: string;
}

/** `/api/hr/reports/monthly` or `/api/admin/reports/monthly`: the same read-only report. */
export const monthlyReportApi = {
  report: (area: ReportArea, { month, fieldId, employeeId }: MonthlyReportQuery) => {
    const query = new URLSearchParams({ month });
    if (fieldId) query.set('fieldId', fieldId);
    if (employeeId) query.set('employeeId', employeeId);
    return apiRequest<MonthlyReport>('GET', `/${area}/reports/monthly?${query}`);
  },
  filters: (area: ReportArea) =>
    apiRequest<MonthlyReportFilters>('GET', `/${area}/reports/monthly/filters`),
};
