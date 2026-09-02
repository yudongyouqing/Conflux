/// <reference types="vite/client" />

interface ConfluxDesktopApi {
  readonly isElectron: true;
  readonly platform: string;
  readonly showWindow: () => void;
}

interface Window {
  readonly confluxDesktop?: ConfluxDesktopApi;
  readonly muiltchatDesktop?: ConfluxDesktopApi;
}
