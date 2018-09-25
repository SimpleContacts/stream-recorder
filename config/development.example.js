import { resolve } from 'path';

/**
 * TODO Deprecate config, the interactive exam using a postUrl, so this
 * app does not need creds to s3 or any configuration at all.
 */

export default {
  aws_access_key: 'AKIAJ44642TLULNR5E2Q',
  aws_secret_key: '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',
  aws_s3_exam_bucket: 'scexams-dev',
  recordings_path: resolve(__dirname, '../recordings'),
};
