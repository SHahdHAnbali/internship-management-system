/** Trainee area data (`/api/trainee/...`). */
export type ApplicationStatus = 'Submitted' | 'UnderReview' | 'Accepted' | 'Rejected';

export interface FieldOption {
  id: string;
  name: string;
  description: string | null;
}

export interface Profile {
  email: string;
  fullName: string | null;
  phone: string | null;
  university: string | null;
  major: string | null;
  studyYear: string | null;
}

export interface Attachment {
  id: string;
  kind: 'Cv' | 'UniversityLetter';
  fileName: string;
  sizeBytes: number;
}

export interface MyApplication {
  id: string;
  field: { id: string; name: string };
  status: ApplicationStatus;
  availableFrom: string;
  availableTo: string;
  hours: number;
  mandatoryForUniversity: boolean;
  submittedAt: string;
  decidedAt: string | null;
  /** The reason HR recorded, only for a Rejected application (AD-61); otherwise null. */
  rejectionReason: string | null;
  attachments: Attachment[];
  /**
   * Only once the final evaluation is submitted (S2.5): its verbal grade (null for an evaluation without criteria) and
   * the original submission time. Absent before the submission.
   */
  finalEvaluation?: { submittedAt: string; grade: VerbalGrade | null };
}

export type VerbalGrade = 'Excellent' | 'VeryGood' | 'Good' | 'Pass' | 'Poor';
