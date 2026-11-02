/** Minimal typing of Google Identity Services (https://developers.google.com/identity/gsi/web) used here. */
interface GoogleAccountsId {
  initialize(config: {
    client_id: string;
    callback: (response: { credential: string }) => void;
    hd?: string;
    ux_mode?: 'popup' | 'redirect';
    auto_select?: boolean;
    itp_support?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: 'standard' | 'icon';
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'large' | 'medium' | 'small';
      text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
      shape?: 'rectangular' | 'pill' | 'circle' | 'square';
      logo_alignment?: 'left' | 'center';
      locale?: string;
      width?: number;
    },
  ): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

// `hl=en`: Google draws the button text in the script's language (otherwise the browser's), so the label is always
// exactly "Sign in with Google".
const SCRIPT_URL = 'https://accounts.google.com/gsi/client?hl=en';
let loading: Promise<GoogleAccountsId> | null = null;

function load(): Promise<GoogleAccountsId> {
  loading ??= new Promise<GoogleAccountsId>((resolve, reject) => {
    if (window.google) {
      resolve(window.google.accounts.id);
      return;
    }

    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.google ? resolve(window.google.accounts.id) : reject(new Error('GIS unavailable'));
    script.onerror = () => {
      loading = null;
      reject(new Error('Google Identity Services could not be loaded.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Renders Google's official sign-in button (PDF §9: staff sign in with Google). Google's ID-token sign-in can only be
 * started from this button; it returns an ID token that the API verifies (client id, verified e-mail). The account
 * chooser is not limited to the staff domain: other Google accounts sign in as ordinary users without a role (AD-42),
 * and the API alone decides who is staff.
 */
export async function renderGoogleButton(
  host: HTMLElement,
  options: { clientId: string; locale: string },
  onCredential: (idToken: string) => void,
): Promise<void> {
  const accounts = await load();
  accounts.initialize({
    client_id: options.clientId,
    callback: (response) => onCredential(response.credential),
    ux_mode: 'popup',
    auto_select: false,
    itp_support: true,
  });
  host.replaceChildren();
  accounts.renderButton(host, {
    type: 'standard',
    theme: 'outline',
    // 'medium' always shows Google's standard button (logo + text). With 'large', Google personalizes it with the
    // signed-in account's name, e-mail and picture, and offers no other setting to turn that off.
    size: 'medium',
    text: 'signin_with',
    shape: 'rectangular',
    logo_alignment: 'center',
    locale: 'en', // fixed label "Sign in with Google" in both page languages
    width: Math.min(Math.max(Math.floor(host.clientWidth), 200), 400),
  });
}
