import {
  BrokerAdapter,
  BrokerConnectionStatus,
  RawBrokerPosition,
  BrokerInstrument,
} from '../types';
import { MOCK_RAW_ZERODHA_POSITIONS } from './fixtures';
import { MOCK_INSTRUMENT_MASTER } from '../../instruments/master';

/**
 * Mock Zerodha Broker Adapter (Phase 3).
 *
 * Implements BrokerAdapter so that the Trading Firewall depends exclusively
 * on the broker abstraction rather than direct Zerodha Kite Connect dependencies.
 */
export class MockZerodhaAdapter implements BrokerAdapter {
  private isConnected: boolean = true;

  public async getConnectionStatus(): Promise<BrokerConnectionStatus> {
    return {
      broker: 'zerodha',
      status: this.isConnected ? 'CONNECTED' : 'DISCONNECTED',
      isMock: true,
      message: 'Mock Zerodha Adapter connected (Phase 3 Sandbox / Test Fixtures)',
      timestamp: new Date().toISOString(),
    };
  }

  public async getPositions(): Promise<RawBrokerPosition[]> {
    // Returns defensive deep copy to prevent mutation
    return JSON.parse(JSON.stringify(MOCK_RAW_ZERODHA_POSITIONS));
  }

  public async getInstruments(): Promise<BrokerInstrument[]> {
    return JSON.parse(JSON.stringify(MOCK_INSTRUMENT_MASTER));
  }

  public setConnected(connected: boolean): void {
    this.isConnected = connected;
  }
}

export const mockZerodhaAdapter = new MockZerodhaAdapter();
