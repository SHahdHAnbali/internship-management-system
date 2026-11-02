# Certificate template (Admin)

The Admin designs the certificate at `/admin/certificate` (AD-43). The template stores **presentation settings only**: preset design, layout, typography, colours, background, border, logo and HR-signature images, QR-code placeholder placement and the static texts. The certificate data (PDF §5: trainee name, training field, university, training period, total hours, trainer name, overall grade, trainer's comment) are filled from the training record when certificates are issued, which is a later module.

- API: `GET`/`PUT /api/admin/certificate-template`, plus `GET`/`PUT`/`DELETE …/logo` and `…/signature` (Admin only, Workers API).
- Settings schema: `backend-workers/src/domain/certificateTemplate.ts` (`CERTIFICATE_SCHEMA_VERSION = 2`). Version 1 templates (three combined fonts: `sans`, `serif`, `elegant`) are upgraded on read and on save to the same fonts.
- Renderer used by the preview: `frontend/src/features/admin/certificate/CertificateView.tsx` (A4 at 96 dpi: 1123 × 794 px landscape, 794 × 1123 px portrait; content scaled down to fit the page if needed).

## Fonts

Every text has an **English** and an **Arabic** font, chosen separately for headings (title, trainee name) and body text. The CSS stack lists the English font first and then the Arabic font, so Latin letters and digits come from the English font and Arabic letters from the Arabic font, in Arabic, English and bilingual certificates alike.

| Id | Family | Script | Style | Notes |
|---|---|---|---|---|
| `inter` | Inter | English | sans-serif | also the app font |
| `montserrat` | Montserrat | English | sans-serif | |
| `poppins` | Poppins | English | sans-serif | |
| `noto-serif` | Noto Serif | English | serif | default heading |
| `lora` | Lora | English | serif | |
| `merriweather` | Merriweather | English | serif | |
| `libre-baskerville` | Libre Baskerville | English | serif | |
| `eb-garamond` | EB Garamond | English | serif | |
| `cormorant-garamond` | Cormorant Garamond | English | display serif | |
| `playfair-display` | Playfair Display | English | display serif | |
| `noto-sans-arabic` | Noto Sans Arabic | Arabic | sans-serif | also the app font |
| `ibm-plex-sans-arabic` | IBM Plex Sans Arabic | Arabic | sans-serif | |
| `cairo` | Cairo | Arabic | sans-serif | |
| `tajawal` | Tajawal | Arabic | sans-serif | |
| `almarai` | Almarai | Arabic | sans-serif | |
| `noto-naskh-arabic` | Noto Naskh Arabic | Arabic | Naskh | default heading |
| `amiri` | Amiri | Arabic | Naskh | |
| `reem-kufi` | Reem Kufi | Arabic | Kufi | |

The ids are stored in saved templates: never rename or remove one without a schema upgrade. All families are Google Fonts under the **SIL Open Font License 1.1** (free to embed, including in PDFs), used at weights **400 and 700**. Italic is not loaded; the trainer's comment uses the browser's synthesized italic.

**Loading in the browser:** only the selected families are downloaded, one `fonts.googleapis.com/css2?family=<Family>:wght@400;700&display=swap` stylesheet each, when first selected (`fonts.ts`, `loadFonts`). Inter and Noto Sans Arabic are already loaded by `index.html`. The site's CSP allows `fonts.googleapis.com` styles and `fonts.gstatic.com` font files.

**For future PDF generation (not implemented):**
1. Render with the same `CertificateView` HTML/CSS at A4 size (or reproduce its layout), with the template settings and the issued certificate's data.
2. The renderer must have the fonts before rendering. A server or headless browser should not depend on Google Fonts at render time: bundle the font files (the TTF/WOFF2 files of the families above at weights 400 and 700, from Google Fonts or the `@fontsource` packages) and declare them with `@font-face` under the **same family names**, so the stored ids map to identical glyphs.
3. Keep the English-then-Arabic stack order (`fontStack` in `fonts.ts`) and embed both fonts of each pair. Arabic shaping needs a renderer with full OpenType/HarfBuzz support (Chromium-based renderers do).
4. Wait for fonts to finish loading (`document.fonts.ready`) before printing, so the fit-to-page step measures the final text.
