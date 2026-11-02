// Prepares fictional trainee applications in the LOCAL IMS, through the real API only (no direct database writes):
// each fictional trainee signs in with the real e-mail code flow (the local Worker writes codes to its log; nothing is
// sent) and submits the PDF §4 application form with a small fictional CV. HR acceptance, mentor requests and their
// approval are NOT done here: they stay real decisions by signed-in HR and Employee users in the app.
//
// Usage (local Worker running with its output in a file, e.g. `npx wrangler dev ... > worker.log`; at least one
// active field created by an Admin):
//   node scripts/seed-local-trainees.mjs --api http://127.0.0.1:5106 --log /path/to/worker.log
//
// Identities are fictional, with reserved `.example` addresses that cannot receive e-mail. The universities are real
// Palestinian universities chosen by the owner for these sample records; they are data, not a list the system enforces. Running it again skips
// trainees that already applied.
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((pairs, value, i, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []),
);
const api = new URL(args.api ?? 'http://127.0.0.1:5106');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)) {
  console.error('Refusing to run: this script only targets a local Worker.');
  process.exit(1);
}
if (!args.log) {
  console.error('Pass --log <file> with the local Worker output (the sign-in codes are written there).');
  process.exit(1);
}

const TRAINEES = [
  {
    fullName: 'Lina Haddad',
    university: 'An-Najah National University',
    major: 'Computer Engineering',
    studyYear: 'Fourth year',
    from: '2027-02-01',
    to: '2027-04-30',
    hours: 240,
    mandatory: true,
  },
  {
    fullName: 'Omar Saleh',
    university: 'Birzeit University',
    major: 'Computer Science',
    studyYear: 'Third year',
    from: '2027-02-15',
    to: '2027-05-15',
    hours: 200,
    mandatory: true,
  },
  {
    fullName: 'Sara Khalil',
    university: 'Palestine Polytechnic University',
    major: 'Software Engineering',
    studyYear: 'Fourth year',
    from: '2027-03-01',
    to: '2027-05-31',
    hours: 300,
    mandatory: false,
  },
  {
    fullName: 'Yousef Nasser',
    university: 'Arab American University',
    major: 'Information Systems',
    studyYear: 'Fifth year',
    from: '2027-06-01',
    to: '2027-08-31',
    hours: 280,
    mandatory: true,
  },
  {
    fullName: 'Maya Odeh',
    university: 'Al-Quds Open University',
    major: 'Computer Engineering',
    studyYear: 'Fifth year',
    from: '2027-06-15',
    to: '2027-09-15',
    hours: 320,
    mandatory: false,
  },
  {
    fullName: 'Karim Daher',
    university: 'Palestine Technical University – Kadoorie',
    major: 'Computer Science',
    studyYear: 'Fourth year',
    from: '2027-07-01',
    to: '2027-08-31',
    hours: 180,
    mandatory: true,
  },
  {
    fullName: 'Rania Fares',
    university: 'An-Najah National University',
    major: 'Software Engineering',
    studyYear: 'Third year',
    from: '2027-09-01',
    to: '2027-11-30',
    hours: 240,
    mandatory: true,
  },
  {
    fullName: 'Tariq Mansour',
    university: 'Birzeit University',
    major: 'Information Systems',
    studyYear: 'Fourth year',
    from: '2027-10-01',
    to: '2027-12-15',
    hours: 200,
    mandatory: false,
  },
].map((t, i) => ({
  ...t,
  email: `${t.fullName.toLowerCase().replace(/\s+/g, '.')}@trainee.example`,
  phone: `000-000-${String(i + 1).padStart(4, '0')}`, // not a real number
}));

/** A minimal one-page PDF saying it is a fictional CV. */
function fictionalCv(name) {
  const text = `Fictional CV - sample data for development - ${name}`;
  const stream = `BT /F1 14 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([pdf], { type: 'application/pdf' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET', body, cookie, ip }) {
  const headers = { 'cf-connecting-ip': ip };
  if (cookie) headers.cookie = cookie;
  if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(path, api), {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  return response;
}

async function signIn(email, ip) {
  const requested = await call('/api/auth/trainee/request', { method: 'POST', body: { email }, ip });
  if (requested.status !== 202) throw new Error(`Sign-in code request for ${email} failed: ${requested.status}`);
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(250);
    const log = readFileSync(args.log, 'utf8');
    const block = log.slice(log.lastIndexOf(`DEVELOPMENT E-MAIL (not sent) to ${email}`));
    const code = /Sign-in code: (\d{6})/.exec(block)?.[1];
    if (block.length > 0 && code) {
      const verified = await call('/api/auth/trainee/verify', { method: 'POST', body: { email, code }, ip });
      if (verified.status !== 200) throw new Error(`Sign-in for ${email} failed: ${verified.status}`);
      return /ims\.session=[^;]+/.exec(verified.headers.get('set-cookie') ?? '')[0];
    }
  }
  throw new Error(`No sign-in code for ${email} found in ${args.log}.`);
}

const summary = [];
for (const [i, t] of TRAINEES.entries()) {
  const ip = `127.10.0.${i + 1}`; // one rate-limit bucket per fictional trainee
  const cookie = await signIn(t.email, ip);
  const existing = await (await call('/api/trainee/applications', { cookie, ip })).json();
  if (existing.length > 0) {
    summary.push(`${t.fullName}: already applied (skipped)`);
    continue;
  }

  const fields = await (await call('/api/trainee/fields', { cookie, ip })).json();
  if (fields.length === 0) {
    console.error('No active training field: an Admin must create at least one field first (Admin > Fields).');
    process.exit(1);
  }

  const field = fields[i % fields.length];
  const form = new FormData();
  for (const [name, value] of Object.entries({
    fullName: t.fullName,
    phone: t.phone,
    university: t.university,
    major: t.major,
    studyYear: t.studyYear,
    fieldId: field.id,
    availableFrom: t.from,
    availableTo: t.to,
    hours: String(t.hours),
    mandatoryForUniversity: String(t.mandatory),
  })) {
    form.append(name, value);
  }
  form.append('cv', fictionalCv(t.fullName), `${t.email.split('@')[0]}-cv.pdf`);
  const submitted = await call('/api/trainee/applications', { method: 'POST', body: form, cookie, ip });
  if (submitted.status !== 201)
    throw new Error(`Application of ${t.fullName} failed: ${submitted.status} ${await submitted.text()}`);
  summary.push(`${t.fullName} <${t.email}>: applied for ${field.name} (${t.from} to ${t.to})`);
}

console.log(summary.join('\n'));
