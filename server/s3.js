// @flow
/* eslint-disable prefer-default-export */

import AWS from 'aws-sdk';
import shortid from 'shortid';
import moment from 'moment';
import { string, number, guard } from 'decoders';
import conf from '../config';

// It is important we use a client constructor rather than changing a global configuration
// that may affect packages or other parts of the system.
// See https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-region.html
const s3 = new AWS.S3({
  accessKeyId: conf.get('aws_access_key'),
  secretAccessKey: conf.get('aws_secret_key'),
  region: 'us-east-1',
  signatureVersion: 'v4',
  s3: { useDualstack: true },
});

export function getSignedDownloadUrl(key: string): string {
  const bucket = conf.get('aws_s3_exam_bucket');
  return `https://${bucket}.s3.dualstack.us-east-1.amazonaws.com/${key}`;
}

export async function upload(video: Buffer, key: string) {
  await s3
    .upload({
      Bucket: conf.get('aws_s3_exam_bucket'),
      Key: key,
      Body: video,
    })
    .promise();

  return { size: video.byteLength, url: getSignedDownloadUrl(key) };
}

export function createS3Key(fileExtension: string): string {
  const date = moment().format('YYYY-MM-DD');
  const epoch = +new Date();
  const rando = shortid.generate();

  return `${date}/kurento${epoch}-${rando}.${fileExtension}`;
}
