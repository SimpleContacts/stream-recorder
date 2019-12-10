/* global window, document, navigator */
import 'webrtc-adapter';
import Recorder, { VideoChat } from './lib';

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
      video: /Android|iPad|iPhone|iPod/.test(navigator.platform)
        ? { facingMode: 'user' }
        : true,
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

    /**
     * TODO Make appropiate updates when s3 is deprecated.
     */
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

const testCall = async (wrapperDiv, isCaller) => {
  // eslint-disable-next-line
  const name = prompt('What is your name?');
  // eslint-disable-next-line
  const whoToCall = isCaller ? prompt('Who would you like to call?') : '';

  // Each test has its own div.
  const div = document.createElement('div');
  div.style.margin = '10px';
  wrapperDiv.appendChild(div);

  div.innerHTML = 'Request user video and audio';
  const videoStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: /Android|iPad|iPhone|iPod/.test(navigator.platform)
      ? { facingMode: 'user' }
      : true,
  });

  div.innerHTML = 'Registering...';
  const chat = await VideoChat({
    url:
      process.env.NODE_ENV === 'production'
        ? 'wss://video.simplecontacts.com/recorder'
        : 'wss://localhost:8088/recorder',
    userId: name,
    videoStream,
  });

  if (isCaller) {
    div.innerHTML = `Calling ${whoToCall}...`;
    const stream = await chat.call(whoToCall);

    const video = document.createElement('video');
    div.innerHTML = '';
    div.appendChild(video);
    video.srcObject = stream;
    video.play();
  } else {
    div.innerHTML = `${name} is waiting for a call...`;
    const stream = await chat.waitForCall();

    const video = document.createElement('video');
    div.innerHTML = '';
    div.appendChild(video);
    video.srcObject = stream;
    video.play();
  }

  await chat.waitForDisconnect();

  div.innerHTML = `The caller disconnected.`;
};

window.onload = async () => {
  /**
   * Recording Test
   */
  const recordingH1 = document.createElement('h1');
  recordingH1.innerHTML = 'Recording Example';
  document.body.appendChild(recordingH1);

  const runTestButton = document.createElement('button');
  runTestButton.style.margin = '10px';
  runTestButton.innerHTML = 'Run Test';
  document.body.appendChild(runTestButton);

  const testDiv = document.createElement('div');
  document.body.appendChild(testDiv);

  runTestButton.addEventListener('click', () => testRecord(testDiv));

  /**
   * Calling Test
   */
  const hr = document.createElement('hr');
  document.body.appendChild(hr);

  const callingH1 = document.createElement('h1');
  callingH1.innerHTML = 'Calling Example';
  document.body.appendChild(callingH1);

  const registerButton = document.createElement('button');
  registerButton.style.margin = '10px';
  registerButton.innerHTML = 'Register and wait for call';
  document.body.appendChild(registerButton);

  const registerAndCallButton = document.createElement('button');
  registerAndCallButton.style.margin = '10px';
  registerAndCallButton.innerHTML = 'Register and call someone';
  document.body.appendChild(registerAndCallButton);

  const callerTestDiv = document.createElement('div');
  document.body.appendChild(callerTestDiv);

  registerButton.addEventListener('click', () =>
    testCall(callerTestDiv, false),
  );
  registerAndCallButton.addEventListener('click', () =>
    testCall(callerTestDiv, true),
  );
};
