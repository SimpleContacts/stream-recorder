/* global window, document */
import Recorder from './lib';

const wait = seconds => new Promise(resolve => setTimeout(resolve, seconds));

const testRecord = async wrapperDiv => {
  // Each test has its own div.
  const div = document.createElement('div');
  div.style.margin = '10px';
  wrapperDiv.appendChild(div);

  try {
    div.innerHTML = 'Connecting to websocket...';
    const recorder = await Recorder('wss://localhost:8088/api/recorder');

    div.innerHTML = 'ICE negotiation...';
    await recorder.start();

    div.innerHTML = 'Recording 3 second of video...';
    await wait(3000);

    div.innerHTML = 'Stopping stream...';
    const { size, url } = await recorder.stop();

    const sizeInKb = parseInt(size / 1024, 10);

    div.innerHTML = `&#10004; Success ${sizeInKb}kb <a href='${url}'>(download)</a>`;
  } catch (e) {
    div.innerHTML += `<strong>Failed!</strong> <pre>${e.stack}</pre>`;
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
