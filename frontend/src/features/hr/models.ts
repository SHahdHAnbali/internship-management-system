/** HR area data (`/api/hr/...`). */
export type ApplicationStatus = 'Submitted' | 'UnderReview' | 'Accepted' | 'Rejected';

export interface HrApplication {
  id: string;
  status: ApplicationStatus;
  field: { id: string; name: string };
  trainee: {
    id: string;
    email: string;
    fullName: string | null;
    phone: string | null;
    university: string | null;
    major: string | null;
    studyYear: string | null;
  };
  availableFrom: string;
  availableTo: string;
  hours: number;
  mandatoryForUniversity: boolean;
  submittedAt: string;
  decidedAt: string | null;
  rejectionReason: string | null;
  attachments?: {
    id: string;
    kind: 'Cv' | 'UniversityLetter';
    fileName: string;
    sizeBytes: number;
  }[];
}

/** PDF §8: phone / meeting / e-mail. */
export type ContactMethod = 'Phone' | 'Meeting' | 'Email';

export interface ContactLogEntry {
  id: string;
  contactDate: string;
  method: ContactMethod;
  summary: string;
  recordedAt: string;
  authorName: string;
}

export type AssignmentStatus = 'Active' | 'Completed' | 'EndedEarly' | 'Transferred' | 'Withdrawn';

/** An assignment as recorded (AD-49 statuses). */
export interface HrAssignment {
  id: string;
  applicationId: string;
  status: AssignmentStatus;
  startDate: string;
  /** The planned end date while Active; the actual end date once ended (AD-63, L3). */
  endDate: string;
  /** The reason HR recorded when ending it early or recording a withdrawal (AD-63); HR only. */
  endReason: string | null;
  trainee: { id: string; fullName: string | null; email: string };
  employee: { id: string; fullName: string; email: string };
  fieldName: string;
}

/** A trainee who applied (the entry to their history). */
export interface HrTrainee {
  id: string;
  email: string;
  fullName: string | null;
  university: string | null;
  applications: number;
}

/** PDF §6 "trainee history": each application with its assignments and contact log, as recorded. */
/** Filters of the trainee history's trainings: a period (`YYYY-MM-DD`, either end optional) and a field; '' = none. */
export interface TraineeHistoryFilters {
  from: string;
  to: string;
  fieldId: string;
}

export interface TraineeHistory {
  /** Every training (assignment) of the trainee, whatever the filters. */
  totalTrainings: number;
  trainee: {
    id: string;
    email: string;
    fullName: string | null;
    phone: string | null;
    university: string | null;
    major: string | null;
    studyYear: string | null;
  };
  applications: {
    id: string;
    status: ApplicationStatus;
    fieldId: string;
    fieldName: string;
    availableFrom: string;
    availableTo: string;
    hours: number;
    submittedAt: string;
    decidedAt: string | null;
    rejectionReason: string | null;
    assignments: {
      id: string;
      employeeName: string;
      status: AssignmentStatus;
      startDate: string;
      endDate: string;
      endReason: string | null;
    }[];
    contactLogs: (Omit<ContactLogEntry, 'recordedAt'> & { recordedAt: string })[];
  }[];
}

export interface HrMentorRequest {
  id: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  note: string;
  requestedAt: string;
  decidedAt: string | null;
  employee: { id: string; fullName: string; email: string };
  application: {
    id: string;
    traineeName: string | null;
    fieldName: string;
    availableFrom: string;
    availableTo: string;
  };
}
