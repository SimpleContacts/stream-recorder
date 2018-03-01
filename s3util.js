import AWS from 'aws-sdk';
import shortid from 'shortid';
import moment from 'moment';
import conf from './config';

async function uploadS3(video, key) {
  const params = {
    Bucket: conf.get('aws_s3_exam_bucket'),
    Key: key,
    Body: video,
  };

  AWS.config.update({
    accessKeyId: conf.get('aws_access_key'),
    secretAccessKey: conf.get('aws_secret_key'),
  });

  const s3 = new AWS.S3();
  const asyncUpload = s3.upload(params).promise();
  await asyncUpload;
  return s3.getSignedUrl('getObject', {
    Bucket: conf.get('aws_s3_exam_bucket'),
    Key: key,
    600,
  });
}

function createS3Key(fileExtension) {
  const date = moment().format('YYYY-MM-DD');
  const epoch = +new Date();
  const rando = shortid.generate();

  return `${date}/kurento${epoch}-${rando}.${fileExtension}`;
}


export { uploadS3, createS3Key };
