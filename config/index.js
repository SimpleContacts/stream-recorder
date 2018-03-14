// @flow
/* eslint-disable import/no-dynamic-require */

import { guard, string, object, optional } from 'decoders';

const confDecoder = object({
  // These fields are used to upload our video to s3.
  aws_s3_exam_bucket: string,
  aws_access_key: string,
  aws_secret_key: string,
  recordings_path: optional(string),
  sentryDsn: optional(string),
});

// Lets make sure our config has everything we expect.
const conf = guard(confDecoder)(
  // $FlowFixMe
  require(`${__dirname}/${process.env.NODE_ENV || 'development'}.js`).default,
);

export default {
  get: (key: string) => conf[key],
};
