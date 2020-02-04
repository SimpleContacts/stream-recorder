import { resolve } from 'path';

/**
 * TODO Deprecate config, the interactive exam using a postUrl, so this
 * app does not need creds to s3 or any configuration at all.
 */

export default {
  aws_access_key: '',
  aws_secret_key: '',
  aws_s3_exam_bucket: '',
  recordings_path: resolve(__dirname, '../recordings'),
};
