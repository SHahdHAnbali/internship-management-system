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
  /**
   * AD-67: Accepted, never assigned, and the signed-in HR is the application's current responsible HR, so they may assign
   * its trainee directly. Computed by the server, which checks the same on the assignment. Only on the detail.
   */
  canDirectAssign?: boolean;
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

/** One extension of a training: the planned end date before and after, the reason, who and when. */
export interface HrAssignmentExtension {
  previousEndDate: string;
  newEndDate: string;
  reason: string;
  extendedAt: string;
  extendedBy: string;
}

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
  /** Every extension, oldest first (AD-63 L2, NEW-35); HR only. */
  extensions: HrAssignmentExtension[];
  trainee: { id: string; fullName: string | null; email: string };
  employee: { id: string; fullName: string; email: string };
  fieldName: string;
  /**
   * AD-65: Active, and the signed-in HR is the application's current responsible HR (AD-64), so may transfer it. The
   * server checks the same on the transfer itself. Absent from an API older than AD-65.
   */
  canTransfer?: boolean;
  /** AD-65: the signed-in HR is the current responsible HR and this assignment has a pending transfer to cancel. */
  canCancelTransfer?: boolean;
  /** AD-65: the transfer decisions taken from this assignment (pending, executed, cancelled, void), oldest first. */
  transferDecisions?: HrTransferDecision[];
  /** AD-65: the assignment this one continues after a transfer, and its mentor. */
  transferredFrom?: HrTransferLink | null;
  /** AD-65: the assignment that continued this one after a transfer, and its mentor. */
  transferredTo?: HrTransferLink | null;
}

export type TransferDecisionStatus = 'Pending' | 'Executed' | 'Cancelled' | 'Void';

/**
 * AD-65: the current responsible HR's decision to transfer a training from an effective date (today: executed at once;
 * later: Pending until the scheduled run of that date). Never deleted: it ends Executed, Cancelled (with who and why) or
 * Void (it could no longer be executed: `resolutionCode`).
 */
export interface HrTransferDecision {
  id: string;
  status: TransferDecisionStatus;
  effectiveDate: string;
  incomingEmployeeName: string;
  reason: string;
  decidedBy: string;
  decidedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionCode: string | null;
  resolutionReason: string | null;
}

export interface HrTransferLink {
  assignmentId: string;
  employeeName: string;
}

/** A user who holds the Employee role now: a possible incoming mentor of a transfer (AD-65). */
export interface HrMentor {
  id: string;
  fullName: string;
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
  /** AD-67: set when the request was rejected because HR assigned the trainee directly. */
  rejectionReason?: string | null;
  employee: { id: string; fullName: string; email: string };
  application: {
    id: string;
    traineeName: string | null;
    fieldName: string;
    availableFrom: string;
    availableTo: string;
  };
}
