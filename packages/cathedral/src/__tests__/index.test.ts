import { runProviderTestSuite } from '@computesdk/test-utils';
import { cathedral } from '../index';

runProviderTestSuite({
  name: 'cathedral',
  provider: cathedral({ apiKey: process.env.CATHEDRAL_API_KEY || 'cat_sk_unit_test_placeholder' }),
  supportsFilesystem: true,
  supportsGetUrl: false,
  // A first create of an image a host has not pulled yet waits for the pull (about 10 to 30 s).
  timeout: 2 * 60 * 1000,
  skipIntegration: !process.env.CATHEDRAL_API_KEY,
});
