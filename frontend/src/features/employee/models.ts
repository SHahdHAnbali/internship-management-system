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
  /** AD-67: set when the request was rejected because HR assigned the trainee directly. */
  rejectionReason?: string | null;
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
  /**
   * AD-65: this is the latest assignment of a training that was transferred to this employee, so they may read the
   * earlier mentors' notes (read-only). Absent from an API older than AD-65.
   */
  canReadEarlierNotes?: boolean;
}

/** An earlier mentor's progress note of the same training (AD-65), read-only. */
export interface EarlierProgressNote {
  id: string;
  writtenAt: string;
  text: string;
  authorName: string;
  assignment: { startDate: string; endDate: string; mentorName: string };
}

export interface ProgressNote {
  id: string;
  writtenAt: string;
  text: string;
  authorName: string;
}
