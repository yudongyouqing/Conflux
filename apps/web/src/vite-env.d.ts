/// <reference types="vite/client" />

interface ConfluxDesktopApi {
  readonly isElectron: true;
  readonly platform: string;
  readonly showWindow: () => void;
  /** Native directory picker (desktop only); resolves null when canceled. */
  readonly pickDirectory?: () => Promise<string | null>;
}

interface Window {
  readonly confluxDesktop?: ConfluxDesktopApi;
  readonly muiltchatDesktop?: ConfluxDesktopApi;
}
