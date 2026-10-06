/**
 * Zerodha Broker Adapter interface (Phase 1 structure).
 * All Zerodha API keys, Kite secrets, and access tokens will remain isolated on the server.
 * The browser will NEVER contain Zerodha secrets.
 */
export interface ZerodhaConfig {
  apiKey?: string;
  apiSecret?: string;
  redirectUrl?: string;
}

export class ZerodhaAdapter {
  private config: ZerodhaConfig;

  constructor(config: ZerodhaConfig = {}) {
    this.config = {
      apiKey: process.env.KITE_API_KEY || config.apiKey,
      apiSecret: process.env.KITE_API_SECRET || config.apiSecret,
      redirectUrl: process.env.KITE_REDIRECT_URL || config.redirectUrl,
    };
  }

  public isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.apiSecret);
  }

  public getStatus() {
    return {
      broker: 'zerodha',
      configured: this.isConfigured(),
      readyForPhase: 7,
    };
  }
}
