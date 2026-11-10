import arMessages from '../../../public/i18n/ar.json?raw';
import enMessages from '../../../public/i18n/en.json?raw';
import { translate, type Messages, type Params } from '../../i18n/translate';
import { describeEntry, labelOf } from './auditDescription';
import type { AuditEntry } from './models';

/** Audit log descriptions in the reader's language (ADL-01 to ADL-06): the event when possible, else a truthful fallback. */
const t = (raw: string) => {
  const messages = JSON.parse(raw) as Messages;
  return (key: string, params?: Params) => translate(messages, key, params);
};
const en = t(enMessages);
const ar = t(arMessages);

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: '1',
  occurredAt: '2031-02-03T10:15:00Z',
  actorType: 'Staff',
  actorId: null,
  actorKnown: true,
  actorName: null,
  actorCurrentRole: null,
  operation: 'UPDATE',
  table: 'employees',
  entityId: null,
  ...overrides,
});
const event = (
  name: string,
  params?: Record<string, string | string[]>,
  rest: Partial<AuditEntry> = {},
) => entry({ description: { event: name, ...(params ? { params } : {}) }, ...rest });

describe('describeEntry', () => {
  it.each([
    [
      event('employee.roleChanged', { fromRole: 'Employee', toRole: 'HR' }),
      "A staff account's role was changed from Employee to HR",
      'تم تغيير دور حساب موظف من «الموظف» إلى «الموارد البشرية»',
    ],
    [
      event(
        'application.createdWithStatus',
        { status: 'Submitted' },
        { operation: 'INSERT', table: 'training_applications' },
      ),
      'A training application was created (status: Submitted)',
      'تم إنشاء طلب تدريب (الحالة: «مُقدَّم»)',
    ],
    [
      event('application.accepted', undefined, { table: 'training_applications' }),
      'A training application was accepted',
      'تم قبول طلب تدريب',
    ],
    [
      event(
        'criterion.changed',
        { changes: ['criterion.weight', 'criterion.order'] },
        { table: 'evaluation_criteria' },
      ),
      'An evaluation criterion was changed (weight, order)',
      'تم تعديل معيار تقييم (الوزن، الترتيب)',
    ],
    [
      event(
        'assignment.statusChanged',
        { fromAssignmentStatus: 'Active', toAssignmentStatus: 'Completed' },
        { table: 'assignments' },
      ),
      "An assignment's status changed from In training to Completed",
      'تغيّرت حالة ربط من «قيد التدريب» إلى «مكتمل»',
    ],
    [
      event('session.signedOut', undefined, { table: 'user_sessions' }),
      'A sign-in session ended (recorded reason: sign-out)',
      'انتهت جلسة دخول (السبب المسجّل: تسجيل الخروج)',
    ],
    [
      event('notification.read', undefined, { table: 'notifications' }),
      'A notification was marked as read',
      'تم تعليم إشعار كمقروء',
    ],
  ])('describes %# in English and Arabic', (item, english, arabic) => {
    expect(describeEntry(en, item)).toBe(english);
    expect(describeEntry(ar, item)).toBe(arabic);
  });

  it.each([
    ['no description (an older API)', entry()],
    ['an event this version does not know', event('employee.somethingNew')],
    [
      'a parameter value it cannot translate',
      event('employee.roleChanged', { fromRole: 'Employee', toRole: 'Owner' }),
    ],
    ['a parameter missing', event('employee.roleChanged', { fromRole: 'Employee' })],
    [
      'an unexpected parameter',
      event('employee.roleChanged', { fromRole: 'Employee', toRole: 'HR', email: 'x@y' }),
    ],
    [
      'an unknown property in a list',
      event('criterion.changed', { changes: ['criterion.secret'] }),
    ],
    [
      'a malformed description',
      entry({ description: { event: 42 } as unknown as AuditEntry['description'] }),
    ],
  ])('falls back to what the table and operation say: %s', (_case, item) => {
    expect(describeEntry(en, item)).toBe('A staff account was updated');
    expect(describeEntry(ar, item)).toBe('تم تحديث حساب موظف');
  });

  it('describes a table this version does not know, and an unknown operation, without raw keys', () => {
    const unknownTable = entry({ table: 'new_table' as AuditEntry['table'], operation: 'INSERT' });
    expect(describeEntry(en, unknownTable)).toBe(
      'A record was created in another part of the system',
    );
    expect(describeEntry(ar, unknownTable)).toBe('تم إنشاء سجل في جزء آخر من النظام');
    const unknownOperation = entry({ operation: 'MERGE' as AuditEntry['operation'] });
    expect(describeEntry(en, unknownOperation)).toBe("A change to the system's data was recorded");
    expect(describeEntry(ar, unknownOperation)).toBe('تم تسجيل تغيير على بيانات النظام');
    expect(labelOf(en, 'tables', 'new_table')).toBe('Other data');
    expect(labelOf(ar, 'tables', 'new_table')).toBe('بيانات أخرى');
    expect(labelOf(en, 'operations', 'MERGE')).toBe('Other');
    expect(labelOf(en, 'tables', 'fields')).toBe('Fields');
  });

  it('is never empty and never shows a key or a placeholder, whatever it is given', () => {
    const odd = [
      entry(),
      entry({ table: '' as AuditEntry['table'] }),
      entry({ operation: '' as AuditEntry['operation'], table: 'x' as AuditEntry['table'] }),
      event(''),
      event('application.createdWithStatus', { status: '{{status}}' }),
      event('criterion.changed', { changes: [] }),
      event('criterion.changed', { changes: 'criterion.weight' }),
    ];
    for (const translateFn of [en, ar]) {
      for (const item of odd) {
        const text = describeEntry(translateFn, item);
        expect(text.trim()).not.toBe('');
        expect(text).not.toMatch(/admin\.auditLog|\{\{|undefined|null/);
      }
    }
  });
});
