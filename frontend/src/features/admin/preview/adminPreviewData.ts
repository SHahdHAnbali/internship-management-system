import type { CertificateSettings, CertificateTemplate } from '../certificate/model';
import type { EvaluationCriterion, Field, NotificationSettings, User } from '../models';

/** Realistic sample data for Preview Mode only. Never sent to or read from the real API. */
export function adminPreviewSeed(): {
  fields: Field[];
  criteria: EvaluationCriterion[];
  users: User[];
  settings: NotificationSettings;
  certificateTemplate: CertificateTemplate;
} {
  return {
    fields: [
      {
        id: 'pv-field-1',
        name: 'Backend',
        description: 'ASP.NET Core Web APIs, PostgreSQL',
        isActive: true,
      },
      {
        id: 'pv-field-2',
        name: 'Frontend',
        description: 'Angular, TypeScript, responsive UI',
        isActive: true,
      },
      { id: 'pv-field-3', name: 'QA', description: 'Manual and automated testing', isActive: true },
      {
        id: 'pv-field-4',
        name: 'تصميم واجهات (UI/UX)',
        description: 'Figma، أبحاث المستخدم، أنظمة التصميم',
        isActive: true,
      },
      { id: 'pv-field-5', name: 'Data & BI', description: null, isActive: false },
    ],
    criteria: [
      { id: 'pv-crit-1', name: 'المهارات التقنية', weight: 3, sortOrder: 1 },
      { id: 'pv-crit-2', name: 'Problem solving', weight: 2, sortOrder: 2 },
      { id: 'pv-crit-3', name: 'العمل الجماعي', weight: 1.5, sortOrder: 3 },
      { id: 'pv-crit-4', name: 'Communication', weight: 1, sortOrder: 4 },
      { id: 'pv-crit-5', name: 'الالتزام بالمواعيد', weight: 1, sortOrder: 5 },
    ],
    users: [
      {
        id: 'pv-user-1',
        fullName: 'سارة أحمد',
        email: 'sara.ahmad@company.example',
        department: 'الموارد البشرية',
        role: 'HR',
      },
      {
        id: 'pv-user-2',
        fullName: 'Omar Khaled',
        email: 'omar.khaled@company.example',
        department: 'Engineering',
        role: 'Employee',
      },
      {
        id: 'pv-user-3',
        fullName: 'لينا حداد',
        email: 'lina.haddad@company.example',
        department: 'Quality',
        role: 'Employee',
      },
      {
        id: 'pv-user-4',
        fullName: 'Yousef Nasser',
        email: 'yousef.nasser@company.example',
        department: 'IT',
        role: 'Admin',
      },
      {
        id: 'pv-user-5',
        fullName: 'Rama Saleh',
        email: 'rama.saleh@company.example',
        department: null,
        role: 'Employee',
      },
    ],
    settings: {
      trainingEndingNoticeDays: 7,
      lateEvaluationReminderDays: 3,
      pendingRequestAlertDays: 5,
    },
    certificateTemplate: {
      settings: previewDefaultCertificate(),
      defaultSettings: previewDefaultCertificate(),
      isDefault: true,
      version: null,
      updatedAt: null,
      logo: null,
      signature: null,
    },
  };
}

/** Preview Mode copy of the API's default design (backend-workers DEFAULT_CERTIFICATE_SETTINGS). */
function previewDefaultCertificate(): CertificateSettings {
  return {
    schemaVersion: 2,
    layout: {
      preset: 'classic',
      orientation: 'landscape',
      alignment: 'center',
      spacing: 'comfortable',
      detailsLayout: 'grid',
    },
    language: 'bilingual',
    typography: {
      headingFont: { en: 'noto-serif', ar: 'noto-naskh-arabic' },
      bodyFont: { en: 'inter', ar: 'noto-sans-arabic' },
      titleSize: 'large',
      nameSize: 'large',
      bodySize: 'medium',
    },
    colors: {
      primary: '#c93d12',
      secondary: '#b08d57',
      heading: '#0f1217',
      text: '#474a4d',
      background: '#ffffff',
    },
    background: { style: 'plain' },
    border: { style: 'double', width: 'medium' },
    logo: { source: 'default', size: 'medium', position: 'center' },
    signature: { visible: true, size: 'medium', position: 'start' },
    qrCode: { size: 'medium', position: 'end' },
    elements: { showTrainerName: true },
    text: {
      title: { ar: 'شهادة إتمام تدريب', en: 'Certificate of Training Completion' },
      intro: {
        ar: 'تشهد شركة ProGineer Technologies بأنّ',
        en: 'ProGineer Technologies certifies that',
      },
      completion: {
        ar: 'قد أتمّ بنجاح البرنامج التدريبي في مجال',
        en: 'has successfully completed the training program in',
      },
      signatureLabel: { ar: 'الموارد البشرية', en: 'Human Resources' },
      footer: { ar: '', en: '' },
    },
  };
}
