import { useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { useAuth } from '../../../auth/context';
import { Dialog } from '../../../components/Dialog';
import { Switch } from '../../../components/Switch';
import { useI18n } from '../../../i18n/context';
import { API_BASE_URL, ApiError } from '../../../lib/api';
import { PageHeader } from '../AdminLayout';
import { adminApi } from '../adminApi';
import { adminCache } from '../adminCache';
import { useAdminFeedback } from '../feedback';
import { useToast } from '../../../components/toastContext';
import { CertificatePreview, type CertificateImages } from './CertificateView';
import { Choice, ColorField, FontField, Section, TextPair } from './controls';
import {
  CERTIFICATE_OPTIONS as O,
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  PRESET_STYLES,
  TEXT_LIMITS,
  validateSettings,
  type CertificateImageKind,
  type CertificateSettings,
  type CertificateTemplate,
  type CertificateTextKey,
} from './model';

const DEFAULT_LOGO = '/brand/progineer-logo.png';
const TEXT_KEYS = Object.keys(TEXT_LIMITS) as CertificateTextKey[];
const SECTIONS = [
  'design',
  'text',
  'typography',
  'colors',
  'logo',
  'signature',
  'elements',
] as const;

/**
 * Admin: the certificate template editor (PDF §4, §5; AD-43). Settings-based (no free positioning), with a live preview
 * on clearly labelled sample data. Design settings are saved together; images are uploaded and removed immediately.
 * The page layout shows at once; until the saved template has loaded (on the first visit in this session) its sections
 * cannot be opened and the preview is a blank page, so nothing unsaved can be shown, edited or saved in its place.
 */
export function CertificateTemplatePage() {
  const { t } = useI18n();
  const feedback = useAdminFeedback();
  const toast = useToast();
  const cacheKey = adminCache.key(useAuth().user?.id, 'certificate-template');
  // The template loaded earlier in this session shows at once and is refreshed in the background (see `load`).
  const [template, setTemplate] = useState<CertificateTemplate | null>(
    () => adminCache.get<CertificateTemplate>(cacheKey) ?? null,
  );
  const [settings, setSettings] = useState<CertificateSettings | null>(
    () => adminCache.get<CertificateTemplate>(cacheKey)?.settings ?? null,
  );
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [localImages, setLocalImages] = useState<Partial<Record<CertificateImageKind, string>>>({});

  const current = useRef({ template, settings });
  useEffect(() => {
    current.current = { template, settings };
  });

  /** A saved template from the API: shown, and remembered for the next visit in this session. */
  const accept = (loaded: CertificateTemplate) => {
    adminCache.set(cacheKey, loaded);
    setTemplate(loaded);
  };

  /**
   * Loads the template. The fresh copy replaces what is shown unless the Admin has already started editing; then a
   * newer saved version is reported as a conflict instead of silently replacing (or being overwritten by) their work.
   * `force` (Reload, Retry) always replaces.
   */
  const load = async ({ force = false } = {}) => {
    try {
      const loaded = await adminApi.getCertificateTemplate();
      const shown = current.current;
      const editing =
        !!shown.template &&
        JSON.stringify(shown.settings) !== JSON.stringify(shown.template.settings);
      if (force || !editing) {
        accept(loaded);
        setSettings(loaded.settings);
        setConflict(false);
        setLocalImages({});
      } else {
        adminCache.set(cacheKey, loaded);
        if (loaded.version !== shown.template?.version) setConflict(true);
      }

      setFailed(false);
    } catch (error) {
      if (!current.current.template) setFailed(true);
      feedback.error(error);
    }
  };

  // Loads once; `load` only uses stable setters and the memoised feedback.
  const loadRef = useRef(load);
  useEffect(() => {
    void loadRef.current();
  }, []);

  const dirty =
    !!template && !!settings && JSON.stringify(settings) !== JSON.stringify(template.settings);
  const errors = useMemo(
    () => (settings ? validateSettings(settings, { logo: !!template?.logo }) : {}),
    [settings, template?.logo],
  );
  const visibleErrors = showErrors ? errors : {};

  // Unsaved changes: confirm before leaving the page inside the app, and before closing or reloading the tab.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const update = (change: (s: CertificateSettings) => CertificateSettings) =>
    setSettings((current) => (current ? change(current) : current));

  const save = async () => {
    if (!settings || !template) return;
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      toast('admin.certificate.errors.fix');
      return;
    }

    setSaving(true);
    try {
      const saved = await adminApi.saveCertificateTemplate(settings, template.version);
      accept(saved);
      setSettings(saved.settings);
      setShowErrors(false);
      feedback.saved();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else feedback.error(error);
    } finally {
      setSaving(false);
    }
  };

  const upload = async (kind: CertificateImageKind, file: File) => {
    if (!IMAGE_TYPES.includes(file.type)) return toast('admin.certificate.errors.imageType');
    if (file.size > IMAGE_MAX_BYTES) return toast('admin.certificate.errors.imageSize');
    try {
      const preview = await readAsDataUrl(file);
      const updated = await adminApi.uploadCertificateImage(kind, file);
      accept(updated);
      setLocalImages((images) => ({ ...images, [kind]: preview }));
      if (kind === 'logo') update((s) => ({ ...s, logo: { ...s.logo, source: 'uploaded' } }));
      toast('admin.certificate.messages.uploaded');
    } catch (error) {
      feedback.error(error);
    }
  };

  const remove = async (kind: CertificateImageKind) => {
    try {
      const updated = await adminApi.removeCertificateImage(kind);
      accept(updated);
      setLocalImages((images) => {
        const next = { ...images };
        delete next[kind];
        return next;
      });
      if (kind === 'logo')
        update((s) =>
          s.logo.source === 'uploaded' ? { ...s, logo: { ...s.logo, source: 'default' } } : s,
        );
      toast('admin.certificate.messages.removed');
    } catch (error) {
      feedback.error(error);
    }
  };

  const imageUrl = (kind: CertificateImageKind) =>
    localImages[kind] ??
    (template?.[kind]
      ? `${API_BASE_URL}/admin/certificate-template/${kind}?v=${template.version ?? ''}`
      : null);

  const images: CertificateImages = settings
    ? {
        logo:
          settings.logo.source === 'default'
            ? DEFAULT_LOGO
            : settings.logo.source === 'uploaded'
              ? imageUrl('logo')
              : null,
        signature: imageUrl('signature'),
      }
    : { logo: null, signature: null };

  const option = (group: string) => (value: string) =>
    t(`admin.certificate.options.${group}.${value}`);
  const languages: ('ar' | 'en')[] =
    settings?.language === 'bilingual' ? ['ar', 'en'] : settings ? [settings.language] : [];

  return (
    <>
      <PageHeader title={t('admin.certificate.title')}>
        <div className="flex flex-wrap items-center gap-2">
          {dirty && <span className="ims-badge">{t('admin.certificate.unsaved')}</span>}
          <button
            type="button"
            className="ims-btn-text"
            disabled={!settings || saving}
            onClick={() => setConfirmReset(true)}
          >
            {t('admin.certificate.reset')}
          </button>
          <button
            type="button"
            className="ims-btn-primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {t('admin.actions.save')}
          </button>
        </div>
      </PageHeader>
      <p className="-mt-4 mb-6 max-w-3xl text-muted">{t('admin.certificate.intro')}</p>

      {failed && !settings && (
        <div className="ims-state flex flex-col items-center gap-3">
          {t('admin.errors.loadFailed')}
          <button
            type="button"
            className="ims-btn-outline"
            onClick={() => void load({ force: true })}
          >
            {t('admin.certificate.retry')}
          </button>
        </div>
      )}

      {conflict && (
        <div
          role="alert"
          className="ims-card mb-6 flex flex-wrap items-center justify-between gap-3 border-primary"
        >
          <p>{t('admin.certificate.errors.conflict')}</p>
          <button
            type="button"
            className="ims-btn-outline"
            onClick={() => void load({ force: true })}
          >
            {t('admin.certificate.reload')}
          </button>
        </div>
      )}

      {!(failed && !settings) && (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <div className="flex flex-col gap-3">
            {!settings || !template ? (
              SECTIONS.map((key) => (
                <Section key={key} title={t(`admin.certificate.sections.${key}`)} disabled />
              ))
            ) : (
              <>
                <Section title={t('admin.certificate.sections.design')}>
                  <Choice
                    legend={t('admin.certificate.fields.preset')}
                    value={settings.layout.preset}
                    options={O.preset}
                    label={option('preset')}
                    hint={t('admin.certificate.hints.preset')}
                    onChange={(preset) => update(PRESET_STYLES[preset])}
                  />
                  <Choice
                    legend={t('admin.certificate.fields.orientation')}
                    value={settings.layout.orientation}
                    options={O.orientation}
                    label={option('orientation')}
                    onChange={(orientation) =>
                      update((s) => ({ ...s, layout: { ...s.layout, orientation } }))
                    }
                  />
                  <Choice
                    legend={t('admin.certificate.fields.alignment')}
                    value={settings.layout.alignment}
                    options={O.alignment}
                    label={option('alignment')}
                    onChange={(alignment) =>
                      update((s) => ({ ...s, layout: { ...s.layout, alignment } }))
                    }
                  />
                  <Choice
                    legend={t('admin.certificate.fields.spacing')}
                    value={settings.layout.spacing}
                    options={O.spacing}
                    label={option('spacing')}
                    onChange={(spacing) =>
                      update((s) => ({ ...s, layout: { ...s.layout, spacing } }))
                    }
                  />
                  <Choice
                    legend={t('admin.certificate.fields.detailsLayout')}
                    value={settings.layout.detailsLayout}
                    options={O.detailsLayout}
                    label={option('detailsLayout')}
                    onChange={(detailsLayout) =>
                      update((s) => ({ ...s, layout: { ...s.layout, detailsLayout } }))
                    }
                  />
                </Section>

                <Section title={t('admin.certificate.sections.text')}>
                  <Choice
                    legend={t('admin.certificate.fields.language')}
                    value={settings.language}
                    options={O.language}
                    label={option('language')}
                    onChange={(language) => update((s) => ({ ...s, language }))}
                  />
                  {TEXT_KEYS.map((key) => (
                    <TextPair
                      key={key}
                      label={t(`admin.certificate.text.${key}`)}
                      hint={key === 'footer' ? t('admin.certificate.hints.footer') : undefined}
                      value={settings.text[key]}
                      max={TEXT_LIMITS[key].max}
                      languages={languages}
                      errors={{
                        ar: visibleErrors[`text.${key}.ar`],
                        en: visibleErrors[`text.${key}.en`],
                      }}
                      onChange={(value) =>
                        update((s) => ({ ...s, text: { ...s.text, [key]: value } }))
                      }
                    />
                  ))}
                  <p className="ims-hint">{t('admin.certificate.hints.dataPlaceholders')}</p>
                </Section>

                <Section title={t('admin.certificate.sections.typography')}>
                  {(['headingFont', 'bodyFont'] as const).map((role) => (
                    <fieldset key={role} className="flex flex-col gap-3">
                      <legend className="ims-label mb-1">
                        {t(`admin.certificate.fields.${role}`)}
                      </legend>
                      {languages.map((lang) => (
                        <FontField
                          key={lang}
                          label={t(`admin.certificate.languages.${lang}`)}
                          script={lang}
                          value={settings.typography[role][lang]}
                          categoryLabel={(category) =>
                            t(`admin.certificate.fontCategories.${category}`)
                          }
                          onChange={(font) =>
                            update((s) => ({
                              ...s,
                              typography: {
                                ...s.typography,
                                [role]: { ...s.typography[role], [lang]: font },
                              },
                            }))
                          }
                        />
                      ))}
                    </fieldset>
                  ))}
                  {(['titleSize', 'nameSize', 'bodySize'] as const).map((key) => (
                    <Choice
                      key={key}
                      legend={t(`admin.certificate.fields.${key}`)}
                      value={settings.typography[key]}
                      options={O.size}
                      label={option('size')}
                      onChange={(size) =>
                        update((s) => ({ ...s, typography: { ...s.typography, [key]: size } }))
                      }
                    />
                  ))}
                </Section>

                <Section title={t('admin.certificate.sections.colors')}>
                  {(['primary', 'secondary', 'heading', 'text', 'background'] as const).map(
                    (key) => (
                      <ColorField
                        key={key}
                        label={t(`admin.certificate.colors.${key}`)}
                        value={settings.colors[key]}
                        onChange={(value) =>
                          update((s) => ({ ...s, colors: { ...s.colors, [key]: value } }))
                        }
                      />
                    ),
                  )}
                  <Choice
                    legend={t('admin.certificate.fields.backgroundStyle')}
                    value={settings.background.style}
                    options={O.backgroundStyle}
                    label={option('backgroundStyle')}
                    onChange={(style) => update((s) => ({ ...s, background: { style } }))}
                  />
                  <Choice
                    legend={t('admin.certificate.fields.borderStyle')}
                    value={settings.border.style}
                    options={O.borderStyle}
                    label={option('borderStyle')}
                    onChange={(style) => update((s) => ({ ...s, border: { ...s.border, style } }))}
                  />
                  {settings.border.style !== 'none' && (
                    <Choice
                      legend={t('admin.certificate.fields.borderWidth')}
                      value={settings.border.width}
                      options={O.borderWidth}
                      label={option('borderWidth')}
                      onChange={(width) =>
                        update((s) => ({ ...s, border: { ...s.border, width } }))
                      }
                    />
                  )}
                </Section>

                <Section title={t('admin.certificate.sections.logo')}>
                  <Choice
                    legend={t('admin.certificate.fields.logoSource')}
                    value={settings.logo.source}
                    options={O.logoSource}
                    label={option('logoSource')}
                    disabled={template.logo ? [] : ['uploaded']}
                    error={visibleErrors['logo.source'] && t(visibleErrors['logo.source'])}
                    onChange={(source) => update((s) => ({ ...s, logo: { ...s.logo, source } }))}
                  />
                  <ImageControls
                    kind="logo"
                    uploaded={!!template.logo}
                    onUpload={(file) => void upload('logo', file)}
                    onRemove={() => void remove('logo')}
                  />
                  {settings.logo.source !== 'none' && (
                    <>
                      <Choice
                        legend={t('admin.certificate.fields.size')}
                        value={settings.logo.size}
                        options={O.size}
                        label={option('size')}
                        onChange={(size) => update((s) => ({ ...s, logo: { ...s.logo, size } }))}
                      />
                      <Choice
                        legend={t('admin.certificate.fields.position')}
                        value={settings.logo.position}
                        options={O.position}
                        label={option('position')}
                        onChange={(position) =>
                          update((s) => ({ ...s, logo: { ...s.logo, position } }))
                        }
                      />
                    </>
                  )}
                </Section>

                <Section title={t('admin.certificate.sections.signature')}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-body">
                      {t('admin.certificate.fields.signatureVisible')}
                    </span>
                    <Switch
                      checked={settings.signature.visible}
                      label={t('admin.certificate.fields.signatureVisible')}
                      onChange={(visible) =>
                        update((s) => ({ ...s, signature: { ...s.signature, visible } }))
                      }
                    />
                  </div>
                  <ImageControls
                    kind="signature"
                    uploaded={!!template.signature}
                    onUpload={(file) => void upload('signature', file)}
                    onRemove={() => void remove('signature')}
                  />
                  {settings.signature.visible && (
                    <>
                      <Choice
                        legend={t('admin.certificate.fields.size')}
                        value={settings.signature.size}
                        options={O.size}
                        label={option('size')}
                        onChange={(size) =>
                          update((s) => ({ ...s, signature: { ...s.signature, size } }))
                        }
                      />
                      <Choice
                        legend={t('admin.certificate.fields.bottomPosition')}
                        value={settings.signature.position}
                        options={O.position}
                        label={option('position')}
                        disabled={[settings.qrCode.position]}
                        onChange={(position) =>
                          update((s) => ({ ...s, signature: { ...s.signature, position } }))
                        }
                      />
                    </>
                  )}
                </Section>

                <Section title={t('admin.certificate.sections.elements')}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-body">
                        {t('admin.certificate.fields.showTrainerName')}
                      </span>
                      <p className="ims-hint">{t('admin.certificate.hints.trainerName')}</p>
                    </div>
                    <Switch
                      checked={settings.elements.showTrainerName}
                      label={t('admin.certificate.fields.showTrainerName')}
                      onChange={(showTrainerName) =>
                        update((s) => ({ ...s, elements: { showTrainerName } }))
                      }
                    />
                  </div>
                  <Choice
                    legend={t('admin.certificate.fields.qrSize')}
                    value={settings.qrCode.size}
                    options={O.size}
                    label={option('size')}
                    onChange={(size) => update((s) => ({ ...s, qrCode: { ...s.qrCode, size } }))}
                  />
                  <Choice
                    legend={t('admin.certificate.fields.qrPosition')}
                    value={settings.qrCode.position}
                    options={O.position}
                    label={option('position')}
                    disabled={settings.signature.visible ? [settings.signature.position] : []}
                    hint={t('admin.certificate.hints.qr')}
                    error={visibleErrors['qrCode.position'] && t(visibleErrors['qrCode.position'])}
                    onChange={(position) =>
                      update((s) => ({ ...s, qrCode: { ...s.qrCode, position } }))
                    }
                  />
                </Section>
              </>
            )}
          </div>

          <section
            aria-labelledby="certificate-preview-title"
            className="ims-card order-first flex min-w-0 flex-col gap-4 lg:sticky lg:top-24 lg:order-none"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="certificate-preview-title" className="text-h3 font-semibold text-heading">
                {t('admin.certificate.previewTitle')}
              </h2>
              <span className="ims-badge">{t('admin.certificate.sampleBadge')}</span>
            </div>
            <p className="ims-hint -mt-2">{t('admin.certificate.previewNote')}</p>
            <div className="overflow-hidden rounded-control bg-surface-subtle p-3 sm:p-5">
              <CertificatePreview
                settings={settings}
                images={images}
                label={t('admin.certificate.previewLabel')}
                placeholder={t('admin.certificate.loadingTemplate')}
              />
            </div>
          </section>
        </div>
      )}

      <Dialog
        open={confirmReset}
        title={t('admin.certificate.resetTitle')}
        onClose={() => setConfirmReset(false)}
      >
        <p>{t('admin.certificate.resetConfirm')}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="ims-btn-text" onClick={() => setConfirmReset(false)}>
            {t('admin.actions.cancel')}
          </button>
          <button
            type="button"
            className="ims-btn-primary"
            onClick={() => {
              if (template) setSettings(template.defaultSettings);
              setShowErrors(false);
              setConfirmReset(false);
            }}
          >
            {t('admin.certificate.resetAction')}
          </button>
        </div>
      </Dialog>

      <Dialog
        open={blocker.state === 'blocked'}
        title={t('admin.certificate.leaveTitle')}
        onClose={() => blocker.reset?.()}
      >
        <p>{t('admin.certificate.leaveMessage')}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="ims-btn-text" onClick={() => blocker.reset?.()}>
            {t('admin.certificate.stay')}
          </button>
          <button type="button" className="ims-btn-primary" onClick={() => blocker.proceed?.()}>
            {t('admin.certificate.leave')}
          </button>
        </div>
      </Dialog>
    </>
  );
}

function ImageControls({
  kind,
  uploaded,
  onUpload,
  onRemove,
}: {
  kind: CertificateImageKind;
  uploaded: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="ims-btn-outline" onClick={() => input.current?.click()}>
          {t(uploaded ? 'admin.certificate.replaceImage' : `admin.certificate.upload.${kind}`)}
        </button>
        {uploaded && (
          <button type="button" className="ims-btn-text" onClick={onRemove}>
            {t('admin.certificate.removeImage')}
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-label={t(`admin.certificate.upload.${kind}`)}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onUpload(file);
          }}
        />
      </div>
      <p className="ims-hint">{t('admin.certificate.hints.image')}</p>
    </div>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
