/** Employee area data (`/api/employee/...`). */
export interface FieldOption {
  id: string;
  name: string;
}

export interface AvailableTrainee {
  applicationId: string;
  trainee: {
    fullName: string | null;
    university: string | null;
    major: string | null;
    studyYear: string | null;
  };
  field: { id: string; name: string };
  availableFrom: string;
  availableTo: string;
  hours: number;
  mandatoryForUniversity: boolean;
  hasCv: boolean;
}

export interface AvailableFilters {
  fieldId: string;
  university: string;
  from: string;
  to: string;
}

export interface MyMentorRequest {
  id: string;
  applicationId: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  note: string;
  requestedAt: string;
  decidedAt: string | null;
  traineeName: string | null;
  fieldName: string;
}

export interface MyTrainee {
  id: string;
  applicationId: string;
  status: 'Active' | 'Completed' | 'EndedEarly' | 'Transferred' | 'Withdrawn';
  startDate: string;
  endDate: string;
  trainee: { fullName: string | null; university: string | null; major: string | null };
  fieldName: string;
}

export interface ProgressNote {
  id: string;
  writtenAt: string;
  text: string;
  authorName: string;
}
