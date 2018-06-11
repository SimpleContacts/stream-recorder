/* global window, document, navigator */
import 'webrtc-adapter';
import Recorder from './lib';

const wait = seconds => new Promise(resolve => setTimeout(resolve, seconds));

const testRecord = async wrapperDiv => {
  // Each test has its own div.
  const div = document.createElement('div');
  div.style.margin = '10px';
  wrapperDiv.appendChild(div);

  const bytesTransferedDiv = document.createElement('div');
  bytesTransferedDiv.style.margin = '10px';
  wrapperDiv.appendChild(bytesTransferedDiv);

  try {
    div.innerHTML = 'Request user video and audio';
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });

    div.innerHTML = 'Setting up...';
    const recorder = await Recorder(
      process.env.NODE_ENV === 'production'
        ? 'wss://video.simplecontacts.com/recorder'
        : 'wss://localhost:8088/recorder',
      'admin',
    );

    div.innerHTML = 'Starting recorder...';
    await recorder.start(
      stream,
      ({ videoBytesSent, networkType, destination }) => {
        const video = parseInt(videoBytesSent / 1024, 10);
        const destinationInfo = destination
          ? `to ${destination} (${networkType})`
          : '';
        bytesTransferedDiv.innerHTML = `
          Streamed <strong>${video}</strong>kb ${destinationInfo}<br />
      `;
      },
    );

    div.innerHTML = 'Recording 3 second of video...';
    await wait(3000);

    div.innerHTML = 'Stop recording...';
    const { size, signedUrl, debugUrl } = await recorder.stop({
      someMetaField: 'bar',
      someMetaField2: 'foo',
    });

    const sizeInKb = parseInt(size / 1024, 10);

    div.innerHTML = `&#10004; Successfully uploaded <strong>${sizeInKb}</strong>kb video to s3 <a href='${signedUrl}'>(download)</a> <a href='${debugUrl}'>(debug info)</a>`;

    // add viewable video (chrome only because safari cannot play webm)
    const video = document.createElement('video');
    video.src = signedUrl;
    video.controls = true;
    wrapperDiv.appendChild(video);
  } catch (e) {
    div.innerHTML += `<strong>Failed! <a href='${e.debugUrl}'>(debug info)</a>`;
    div.innerHTML += `</strong> <pre>${e.stack}</pre>`;
  }
};

window.onload = async () => {
  const runTestButton = document.createElement('button');
  runTestButton.style.margin = '10px';
  runTestButton.innerHTML = 'Run Test';
  document.body.appendChild(runTestButton);

  const testDiv = document.createElement('div');
  document.body.appendChild(testDiv);

  runTestButton.addEventListener('click', () => testRecord(testDiv));
};
