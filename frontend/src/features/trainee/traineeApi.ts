import { apiRequest } from '../../lib/api';
import type { FieldOption, MyApplication, Profile } from './models';

/** Trainee API (`/api/trainee/...`, Trainee role only, always the signed-in trainee's own data). */
export const traineeApi = {
  fields: () => apiRequest<FieldOption[]>('GET', '/trainee/fields'),
  profile: () => apiRequest<Profile>('GET', '/trainee/profile'),
  applications: () => apiRequest<MyApplication[]>('GET', '/trainee/applications'),
  /** The application form (PDF §4) as multipart: profile, request, `cv` and any `letters`. */
  submit: (form: FormData) => apiRequest<{ id: string }>('POST', '/trainee/applications', form),
  fileLink: (attachmentId: string) =>
    apiRequest<{ url: string }>('POST', `/trainee/attachments/${attachmentId}/link`),
};
