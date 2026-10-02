import { runProviderTestSuite } from '@computesdk/test-utils';
import { cathedral } from '../index';

runProviderTestSuite({
  name: 'cathedral',
  provider: cathedral({ apiKey: process.env.CATHEDRAL_API_KEY || 'cat_sk_unit_test_placeholder' }),
  supportsFilesystem: true,
  supportsGetUrl: false,
  // A first create on an account with no running Standard VM starts one (about 5 to 6 minutes).
  timeout: 10 * 60 * 1000,
  skipIntegration: !process.env.CATHEDRAL_API_KEY,
});
