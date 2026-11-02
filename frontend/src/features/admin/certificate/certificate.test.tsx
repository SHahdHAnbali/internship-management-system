import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderPage, renderRoutes } from '../../../test/render';
import { adminPreviewSeed } from '../preview/adminPreviewData';
import { CertificateTemplatePage } from './CertificateTemplatePage';
import { CertificateView } from './CertificateView';
import { validateSettings, type CertificateSettings, type CertificateTemplate } from './model';

afterEach(() => vi.unstubAllGlobals());

const seed = (): CertificateTemplate => adminPreviewSeed().certificateTemplate;
const defaults = (): CertificateSettings => seed().defaultSettings;
const images = { logo: '/brand/progineer-logo.png', signature: null };

describe('CertificateView', () => {
  it('has no SAMPLE / نموذج watermark, while the sample data stay labelled as samples', () => {
    for (const language of ['ar', 'en', 'bilingual'] as const) {
      const { unmount } = render(
        <CertificateView settings={{ ...defaults(), language }} images={images} />,
      );
      const certificate = screen.getByTestId('certificate');
      expect(within(certificate).queryByText(/^(SAMPLE|نموذج)( · (SAMPLE|نموذج))?$/)).toBeNull();
      expect(
        [...certificate.querySelectorAll<HTMLElement>('*')].some((e) =>
          e.style.transform.includes('rotate(-24deg)'),
        ),
      ).toBe(false);
      expect(within(certificate).getAllByText(/\(sample\)|\(نموذج\)/).length).toBeGreaterThan(0);
      unmount();
    }
  });

  it('shows every PDF §5 item with labelled sample data and a QR placeholder', () => {
    render(<CertificateView settings={{ ...defaults(), language: 'en' }} images={images} />);
    const certificate = screen.getByTestId('certificate');
    for (const text of [
      'Certificate of Training Completion',
      'Trainee Name (sample)',
      'Web Development (sample)',
      'University Name (sample)',
      'Training period',
      'Total training hours',
      'Trainer Name (sample)',
      'Excellent (sample)',
      "Trainer's comment",
      'QR code placeholder (not a verification code)',
    ]) {
      expect(within(certificate).getAllByText(text, { exact: false }).length).toBeGreaterThan(0);
    }

    expect(certificate).toHaveAttribute('dir', 'ltr');
  });

  it("hides the trainer's name when the template says so", () => {
    render(
      <CertificateView
        settings={{ ...defaults(), language: 'en', elements: { showTrainerName: false } }}
        images={images}
      />,
    );
    expect(screen.queryByText('Trainer Name (sample)')).not.toBeInTheDocument();
    expect(screen.getByText('Excellent (sample)')).toBeInTheDocument();
  });

  it('renders Arabic right-to-left, and both languages when bilingual', () => {
    const { unmount } = render(
      <CertificateView settings={{ ...defaults(), language: 'ar' }} images={images} />,
    );
    expect(screen.getByTestId('certificate')).toHaveAttribute('dir', 'rtl');
    expect(screen.queryByText('Certificate of Training Completion')).not.toBeInTheDocument();
    unmount();

    render(<CertificateView settings={defaults()} images={images} />);
    expect(screen.getByText('شهادة إتمام تدريب')).toBeInTheDocument();
    expect(screen.getByText('Certificate of Training Completion')).toBeInTheDocument();
  });
});

describe('certificate fonts', () => {
  const loaded = () =>
    [...document.head.querySelectorAll<HTMLLinkElement>('link[data-certificate-font]')].map(
      (l) => l.dataset['certificateFont'],
    );

  it('draws headings and text with the selected English and Arabic fonts, loading only those', () => {
    const settings = defaults();
    settings.typography.headingFont = { en: 'playfair-display', ar: 'reem-kufi' };
    settings.typography.bodyFont = { en: 'lora', ar: 'cairo' };
    render(<CertificateView settings={settings} images={images} />);

    const title = screen.getByRole('heading', { level: 2 });
    expect(title.style.fontFamily).toContain('Playfair Display');
    expect(title.style.fontFamily).toContain('Reem Kufi');
    expect(screen.getByTestId('certificate').style.fontFamily).toContain('Lora');
    expect(screen.getByTestId('certificate').style.fontFamily).toContain('Cairo');
    expect(loaded()).toEqual(
      expect.arrayContaining(['playfair-display', 'reem-kufi', 'lora', 'cairo']),
    );
    expect(loaded()).not.toContain('montserrat');
    expect(loaded()).not.toContain('inter'); // already loaded by the app
    const link = document.head.querySelector<HTMLLinkElement>(
      'link[data-certificate-font="reem-kufi"]',
    )!;
    expect(link.href).toBe(
      'https://fonts.googleapis.com/css2?family=Reem+Kufi:wght@400;700&display=swap',
    );
  });

  it('offers every font in the editor, with a sample in the selected font, and applies it to the preview', async () => {
    mockFetch(() => [200, seed()]);
    renderPage(<CertificateTemplatePage />);
    const user = userEvent.setup();
    await screen.findAllByTestId('font-sample-en');
    const selects = screen.getAllByRole('combobox');
    const englishHeading = selects.find((s) =>
      within(s).queryByRole('option', { name: /Playfair Display/ }),
    )!;
    const arabicHeading = selects.find((s) =>
      within(s).queryByRole('option', { name: /Reem Kufi/ }),
    )!;
    expect(within(englishHeading).getAllByRole('option')).toHaveLength(10);
    expect(within(arabicHeading).getAllByRole('option')).toHaveLength(8);

    await user.selectOptions(englishHeading, 'playfair-display');
    await user.selectOptions(arabicHeading, 'reem-kufi');

    expect(screen.getAllByTestId('font-sample-en')[0]!.style.fontFamily).toContain(
      'Playfair Display',
    );
    const title = within(screen.getByTestId('certificate')).getByRole('heading', { level: 2 });
    expect(title.style.fontFamily).toContain('Playfair Display');
    expect(title.style.fontFamily).toContain('Reem Kufi');
    expect(screen.getByText('admin.certificate.unsaved')).toBeInTheDocument();
  });

  it('shows only the font choices for the certificate language', async () => {
    const english = seed();
    english.settings = { ...english.settings, language: 'en' };
    mockFetch(() => [200, english]);
    renderPage(<CertificateTemplatePage />);
    await waitFor(() => expect(screen.getAllByTestId('font-sample-en')).toHaveLength(2));
    expect(screen.queryAllByTestId('font-sample-ar')).toHaveLength(0);
  });
});

describe('validateSettings', () => {
  it('checks text lengths, required texts per language, positions and the uploaded logo', () => {
    const settings = defaults();
    expect(validateSettings(settings, { logo: false })).toEqual({});

    settings.text.title.en = 'x'.repeat(81);
    settings.text.intro.ar = '  ';
    settings.qrCode.position = settings.signature.position;
    settings.logo.source = 'uploaded';
    expect(validateSettings(settings, { logo: false })).toEqual({
      'text.title.en': 'admin.certificate.errors.tooLong',
      'text.intro.ar': 'admin.validation.required',
      'qrCode.position': 'admin.certificate.errors.samePosition',
      'logo.source': 'admin.certificate.errors.logoMissing',
    });

    expect(validateSettings({ ...settings, language: 'en' }, { logo: true })).not.toHaveProperty(
      'text.intro.ar',
    );
  });
});

describe('CertificateTemplatePage', () => {
  const titleInputs = () => screen.getAllByLabelText('admin.certificate.languages.en');

  const SECTION_TITLES = [
    'design',
    'text',
    'typography',
    'colors',
    'logo',
    'signature',
    'elements',
  ].map((key) => `admin.certificate.sections.${key}`);
  const summary = (title: string) => screen.getByText(title).closest('summary')!;
  const isOpen = (title: string) => summary(title).closest('details')!.open;

  /** A fetch whose responses are released by hand, to look at the page while the template is loading. */
  function slowFetch() {
    const pending: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    return {
      fetchMock,
      respond: (body: unknown, status = 200) =>
        pending.shift()!(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    };
  }

  it('shows the editor and the preview page at once, with nothing to edit or save until the saved template arrives', async () => {
    const api = slowFetch();
    const saved = seed();
    saved.settings.text.title.en = 'Saved title';
    saved.settings.language = 'en';
    renderPage(<CertificateTemplatePage />);
    const user = userEvent.setup();

    // Immediately: every section and the preview page are there, but nothing can be opened, edited or saved.
    for (const title of SECTION_TITLES) {
      expect(summary(title)).toHaveAttribute('aria-disabled', 'true');
      await user.click(summary(title));
      expect(isOpen(title)).toBe(false);
    }
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'admin.actions.save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'admin.certificate.reset' })).toBeDisabled();
    expect(screen.getByText('admin.certificate.loadingTemplate')).toBeInTheDocument();
    expect(screen.queryByTestId('certificate')).not.toBeInTheDocument(); // no design that was not saved

    api.respond(saved);
    const certificate = await screen.findByTestId('certificate');
    expect(within(certificate).getByText('Saved title')).toBeInTheDocument();
    expect(screen.queryByText('admin.certificate.loadingTemplate')).not.toBeInTheDocument();
    for (const title of SECTION_TITLES) expect(summary(title)).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText('admin.certificate.unsaved')).not.toBeInTheDocument();
    expect(api.fetchMock).toHaveBeenCalledTimes(1); // only the GET: nothing was saved
  });

  it('when the first load fails, shows the error and a retry instead of the editor', async () => {
    const api = slowFetch();
    renderPage(<CertificateTemplatePage />);
    expect(summary(SECTION_TITLES[0]!)).toHaveAttribute('aria-disabled', 'true');

    api.respond({ status: 500 }, 500);
    expect(await screen.findByText('admin.errors.loadFailed')).toBeInTheDocument();
    expect(screen.queryByText(SECTION_TITLES[0]!)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'admin.certificate.retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'admin.actions.save' })).toBeDisabled();
  });

  it('starts with every section closed; each opens and closes on its own, by mouse', async () => {
    mockFetch(() => [200, seed()]);
    renderPage(<CertificateTemplatePage />);
    const user = userEvent.setup();
    await screen.findByTestId('certificate');

    expect(SECTION_TITLES.map(isOpen)).toEqual(SECTION_TITLES.map(() => false));

    await user.click(summary('admin.certificate.sections.design'));
    await user.click(summary('admin.certificate.sections.colors'));
    expect(SECTION_TITLES.filter(isOpen)).toEqual([
      'admin.certificate.sections.design',
      'admin.certificate.sections.colors',
    ]);
    await user.click(summary('admin.certificate.sections.design'));
    expect(SECTION_TITLES.filter(isOpen)).toEqual(['admin.certificate.sections.colors']);
    // Keyboard (Enter/Space on the native <summary>) is browser behaviour jsdom does not implement: checked in Chrome.
  });

  it('loads the template, previews changes immediately and saves them with the version', async () => {
    const saved = { ...seed(), isDefault: false, version: '41' };
    const fetchMock = mockFetch((method, _url, body) =>
      method === 'GET'
        ? [200, saved]
        : [200, { ...saved, settings: (body as { settings: unknown }).settings, version: '42' }],
    );
    renderPage(<CertificateTemplatePage />);
    const user = userEvent.setup();

    const title = (await waitFor(() => titleInputs()))[0]!;
    expect(screen.queryByText('admin.certificate.unsaved')).not.toBeInTheDocument();
    await user.clear(title);
    await user.type(title, 'Internship Certificate');

    expect(
      within(screen.getByTestId('certificate')).getByText('Internship Certificate'),
    ).toBeInTheDocument();
    expect(screen.getByText('admin.certificate.unsaved')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'admin.actions.save' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(true),
    );
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(put[0]).toBe('/api/admin/certificate-template');
    const sent = JSON.parse(String(put[1]!.body));
    expect(sent.version).toBe('41');
    expect(sent.settings.text.title.en).toBe('Internship Certificate');
    await waitFor(() =>
      expect(screen.queryByText('admin.certificate.unsaved')).not.toBeInTheDocument(),
    );
  });

  it('resets every setting to the default design after confirmation, without saving', async () => {
    const custom = seed();
    custom.settings = {
      ...custom.settings,
      language: 'en',
      layout: { ...custom.settings.layout, preset: 'modern' },
    };
    custom.settings.text.title.en = 'Custom title';
    const fetchMock = mockFetch(() => [200, custom]);
    renderPage(<CertificateTemplatePage />);
    const user = userEvent.setup();
    expect(await screen.findByText('Custom title')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'admin.certificate.reset' }));
    await user.click(screen.getByRole('button', { name: 'admin.certificate.resetAction' }));

    const certificate = screen.getByTestId('certificate');
    expect(within(certificate).getByText('Certificate of Training Completion')).toBeInTheDocument();
    expect(within(certificate).getByText('شهادة إتمام تدريب')).toBeInTheDocument(); // bilingual again
    expect(screen.getByText('admin.certificate.unsaved')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false);
  });

  it('does not save invalid settings and shows the error next to the setting', async () => {
    const fetchMock = mockFetch(() => [200, seed()]);
    renderPage(<CertificateTemplatePage />);
    const user = userEvent.setup();
    const title = (await waitFor(() => titleInputs()))[0]!;

    await user.clear(title);
    await user.click(screen.getByRole('button', { name: 'admin.actions.save' }));

    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByText('admin.validation.required').length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false);
  });

  it('explains a conflicting change and reloads on request', async () => {
    let gets = 0;
    mockFetch((method) => {
      if (method === 'GET') {
        gets++;
        return [200, { ...seed(), version: String(gets) }];
      }

      return [409, { status: 409, code: 'conflict.concurrent_update' }];
    });
    renderPage(<CertificateTemplatePage />);
    const user = userEvent.setup();
    const title = (await waitFor(() => titleInputs()))[0]!;
    await user.type(title, '!');
    await user.click(screen.getByRole('button', { name: 'admin.actions.save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('admin.certificate.errors.conflict');
    await user.click(screen.getByRole('button', { name: 'admin.certificate.reload' }));
    await waitFor(() => expect(gets).toBe(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('uploads a valid image immediately and refuses files that are too large or of another type', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', url, body: init?.body });
        const body =
          init?.method === 'PUT'
            ? { ...seed(), version: '2', logo: { contentType: 'image/png' } }
            : seed();
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderPage(<CertificateTemplatePage />);
    const user = userEvent.setup({ applyAccept: false });
    const input = await screen.findByLabelText('admin.certificate.upload.logo');

    await user.upload(input, new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    await user.upload(
      input,
      new File([new Uint8Array(512 * 1024 + 1)], 'big.png', { type: 'image/png' }),
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);

    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', {
      type: 'image/png',
    });
    await user.upload(input, png);
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    const upload = calls.find((c) => c.method === 'PUT')!;
    expect(upload.url).toBe('/api/admin/certificate-template/logo');
    expect(upload.body).toBe(png);
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: 'admin.certificate.options.logoSource.uploaded' }),
      ).toBeChecked(),
    );
  });

  it('asks before leaving the page with unsaved changes', async () => {
    mockFetch(() => [200, seed()]);
    const { router } = renderRoutes(
      [
        { path: '/admin/certificate', element: <CertificateTemplatePage /> },
        { path: '/admin/fields', element: <p>fields page</p> },
      ],
      { url: '/admin/certificate' },
    );
    const user = userEvent.setup();
    const title = (await waitFor(() => titleInputs()))[0]!;
    await user.type(title, '!');

    await router.navigate('/admin/fields');
    expect(await screen.findByText('admin.certificate.leaveMessage')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'admin.certificate.stay' }));
    expect(router.state.location.pathname).toBe('/admin/certificate');

    await router.navigate('/admin/fields');
    await user.click(await screen.findByRole('button', { name: 'admin.certificate.leave' }));
    expect(await screen.findByText('fields page')).toBeInTheDocument();
  });
});
