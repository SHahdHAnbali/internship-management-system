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
  attachments: Attachment[];
}
