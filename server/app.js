/* eslint-disable consistent-return, no-console, no-plusplus, no-await-in-loop */
// @flow

import express from 'express';
import { promisify } from 'util';
import fs from 'fs';
import http from 'http';
import kurento from 'kurento-client';
import Raven from 'raven';
import ws from 'ws';
import path from 'path';
import idx from 'idx';
import conf from '../config';

import { upload, createS3Key } from './s3';

const RECORDINGS_PATH = conf.get('recordings_path') || '/tmp/kurento';
const ADMINJS_PATH = path.resolve(__dirname, '../dist/admin/index.js');
const CLIENTJS_PATH = path.resolve(__dirname, '../dist/api/client.js');

const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);

const app = express();

const wait = seconds => new Promise(resolve => setTimeout(resolve, seconds));

// These files are served by express in production.
if (process.env.NODE_ENV === 'production') {
  const adminJs = fs.readFileSync(ADMINJS_PATH);
  const clientJs = fs.readFileSync(CLIENTJS_PATH);
  app.get('/admin', (req, res) => {
    res.send(`<body><script src="/admin/index.js"></script></body>`);
  });
  app.get('/admin/index.js', (req, res) => res.send(adminJs));
  app.get('/client.js', (req, res) => res.send(clientJs));
}

// Global Error catching.
// NOTE If no DSN is provided here, there are no side-effects.
Raven.config(conf.get('sentry_dsn'), {
  autoBreadcrumbs: true,
  captureUnhandledRejections: true,
}).install((err, sendErr) => {
  if (conf.get('sentry_dsn') && sendErr) {
    console.error('Error Sending request to Sentry');
    console.error(err.stack);
    console.log('This is thy sheath; there rust, and let me die.');
    process.exit(1);
  }
});

/*
 * Global State
 * This can be redux or soemthing else future.
 */
const globalState = {
  // This indicates the session.
  processId: Date.now(),
  // This is also used to give sessionId
  numJobs: 0,
  sessions: {},
  kurentoClient: null,
};

// Selectors
const getState = () => globalState;
const getCandidatesQueue = sessionId =>
  idx(getState(), _ => _.sessions[sessionId].candidatesQueue);
const getWebRtcEndpoint = sessionId =>
  idx(getState(), _ => _.sessions[sessionId].webRtcEndpoint);
const getRecorder = sessionId =>
  idx(getState(), _ => _.sessions[sessionId].recorder);
const getPipeline = sessionId =>
  idx(getState(), _ => _.sessions[sessionId].pipeline);
const numSessions = () => Object.keys(getState().sessions).length;

const addToTimeline = (sessionId, action, timestamp = Date.now()) => {
  if (!globalState.sessions[sessionId]) {
    return;
  }

  if (!globalState.sessions[sessionId].timeline) {
    globalState.sessions[sessionId].timeline = [];
  }

  globalState.sessions[sessionId].timeline.push(
    `${action}:${timestamp - globalState.sessions[sessionId].start}`,
  );
};

/*
 * Server startup
 */
const server = http.createServer(app);

const wss = new ws.Server({
  server,
  path: '/recorder',
});

/*
 * Definition of functions
 */

// In order to control the media capabilities provided by the Kurento Media
// Server, we need an instance of the KurentoClient in the Node application
// server. In order to create this instance, we need to specify to the client
// library the location of the Kurento Media Server.
async function getKurentoClient() {
  if (globalState.kurentoClient) {
    return globalState.kurentoClient;
  }
  const client = await kurento('ws://localhost:8888/kurento');
  globalState.kurentoClient = client;
  return globalState.kurentoClient;
}

// Util function to send message via websocket
function sendMessage(message, connection) {
  if (connection) {
    const jsonMessage = JSON.stringify(message);
    return connection.send(jsonMessage);
  }
  throw new Error('No websocket connection');
}

async function makeSureRecorderIsRunning(sessionId) {
  let state = await globalState.sessions[sessionId].recorder.getState();
  while (state !== 'START') {
    state = await globalState.sessions[sessionId].recorder.getState();
    await wait(250);
  }
}

async function cleanup(sessionId) {
  let recorderState;
  try {
    recorderState = await globalState.sessions[sessionId].recorder.getState();
  } catch (e) {
    Raven.captureException(e);
  }

  const pipeline = getPipeline(sessionId);
  const recorder = getRecorder(sessionId);
  if (recorder && recorderState !== 'STOP') {
    addToTimeline(sessionId, 'server:recorder.stop');
    recorder.stop();
  } else {
    addToTimeline(sessionId, 'server:recorderAlreadyStopped');
  }

  if (pipeline) {
    addToTimeline(sessionId, 'server:pipeline.release');
    pipeline.release();
  }

  try {
    globalState.sessions[sessionId].stop = Date.now();
    console.log(`#${sessionId} Stopped - ${numSessions()} job(s) now running`);
    return upload(
      JSON.stringify(
        { ...globalState.sessions[sessionId], recorderState },
        null,
        2,
      ),
      `videoDebug/${globalState.processId}-${sessionId}.txt`,
    );
  } catch (e) {
    Raven.captureException(e);
  }

  return null;
}

async function captureException(e, conn, sessionId, videoKey, message) {
  console.error(e);
  // Lets not throw here, otherwise we may break other sessions who are recording.

  let serializedSession;
  let serializedGlobalState;
  try {
    serializedSession = JSON.parse(
      JSON.stringify(globalState.sessions[sessionId]),
    );
  } catch (e1) {
    // ignore
  }

  try {
    serializedGlobalState = JSON.parse(JSON.stringify(globalState));
  } catch (e2) {
    // ignore
  }

  Raven.captureException(e, {
    extra: {
      sessionId,
      videoKey,
      message,
      session: serializedSession,
      globalState: serializedGlobalState,
    },
  });

  addToTimeline(sessionId, e.message);
  const debug = await cleanup(sessionId);
  return sendMessage(
    {
      id: 'error',
      debugUrl: debug.url,
      message,
      error: e.stack,
      // process.env.NODE_ENV === 'production'
      //   ? 'Server Side Error'
      //   : e.stack,
    },
    conn,
  );
}

async function start(sessionId, conn, sdpOffer, videoKey) {
  console.log(
    `#${sessionId} Started - ${numSessions() + 1} job(s) now running`,
  );

  addToTimeline(sessionId, 'server:getKurentoClient');
  const client = await getKurentoClient();

  addToTimeline(sessionId, 'server:client.create');
  const pipeline = await client.create('MediaPipeline');

  addToTimeline(sessionId, 'server:pipeline.create');
  const elements = await promisify(pipeline.create)([
    {
      type: 'RecorderEndpoint',
      params: { uri: `file:///tmp/kurento/${videoKey}` },
    },
    {
      type: 'WebRtcEndpoint',
    },
  ]);

  const [recorder, webRtcEndpoint] = elements;
  globalState.sessions[sessionId].webRtcEndpoint = webRtcEndpoint;
  globalState.sessions[sessionId].recorder = recorder;

  // don't cap quality.
  await recorder.setMaxOutputBitrate(0);

  if (getCandidatesQueue(sessionId)) {
    addToTimeline(sessionId, 'server:flushQueuedCandidates');
    (getCandidatesQueue(sessionId) || []).forEach(candidate =>
      webRtcEndpoint.addIceCandidate(candidate),
    );
    globalState.sessions[sessionId].candidatesQueue = [];
  }

  webRtcEndpoint.on('OnIceGatheringDone', () => {
    addToTimeline(sessionId, 'server:IceGatheringDone');
  });

  webRtcEndpoint.on('OnIceCandidate', event => {
    const candidate = kurento.getComplexType('IceCandidate')(event.candidate);
    sendMessage(
      {
        id: 'iceCandidate',
        candidate,
      },
      conn,
    );
  });

  addToTimeline(sessionId, 'server:processOffer');
  const sdpAnswer = await webRtcEndpoint.processOffer(sdpOffer);
  globalState.sessions[sessionId].pipeline = pipeline;

  addToTimeline(sessionId, 'server:gatherCandidates');
  await webRtcEndpoint.gatherCandidates();

  // start recording only after media arrives
  webRtcEndpoint.on('MediaFlowOutStateChange', async s => {
    try {
      addToTimeline(sessionId, `server:incoming${s.mediaType}`);
      globalState.sessions[sessionId][`incoming_${s.mediaType}`] = true;

      if (
        globalState.sessions[sessionId].incoming_AUDIO &&
        globalState.sessions[sessionId].incoming_VIDEO
      ) {
        addToTimeline(sessionId, 'server:record');
        await client.connect(webRtcEndpoint, recorder);
        await recorder.record();
        globalState.sessions[sessionId].recording = true;

        await makeSureRecorderIsRunning(sessionId);
        console.log(
          `#${sessionId} Recording - ${numSessions() + 1} job(s) now running`,
        );
        sendMessage(
          {
            id: 'recordingStarted',
          },
          conn,
        );
      }
    } catch (e) {
      captureException(
        e,
        conn,
        sessionId,
        videoKey,
        'ERROR IN MediaFlowOutStateChange',
      );
    }
  });

  return sendMessage(
    {
      id: 'startResponse',
      sdpAnswer,
    },
    conn,
  );
}

async function stop(sessionId, videoKey) {
  addToTimeline(sessionId, 'server:stop');
  if (!globalState.sessions[sessionId]) {
    throw new Error('Already stopped!');
  }

  globalState.sessions[sessionId].recording = false;

  // the recording was saved to the machine at /var/kurento/myrecording.webm
  const filepath = path.join(RECORDINGS_PATH, videoKey);

  // Upload file
  const data = await readFile(filepath);
  const response = await upload(data, videoKey);

  // NOTE: Order is important, only remove file if upload was successful.
  await unlink(filepath);
  if (response.size === 0) {
    throw new Error('No frames captured');
  }
  const debug = await cleanup(sessionId);

  return { ...response, debugUrl: debug.url };
}

// As of Kurento Media Server 6.0, the WebRTC negotiation is done by exchanging ICE
// candidates between the WebRTC peers. To implement this protocol, the
// webRtcEndpoint receives candidates from the client in OnIceCandidate function.
// These candidates are stored in a queue when the webRtcEndpoint is not available
// yet. Then these candidates are added to the media element by calling to the
// addIceCandidate method.
async function onIceCandidate(sessionId, _candidate) {
  const candidate = kurento.getComplexType('IceCandidate')(_candidate);

  if (getWebRtcEndpoint(sessionId)) {
    addToTimeline(sessionId, 'server:addCandidate');
    getWebRtcEndpoint(sessionId).addIceCandidate(candidate);
  } else {
    addToTimeline(sessionId, 'server:queueCandidate');
    globalState.sessions[sessionId].candidatesQueue = !getCandidatesQueue(
      sessionId,
    )
      ? [candidate]
      : (getCandidatesQueue(sessionId) || []).concat(candidate);
  }
}

/*
 * Management of WebSocket messages
 */
wss.on('connection', conn => {
  const sessionId = ++globalState.numJobs;
  const videoKey = createS3Key('mp4');
  globalState.sessions[sessionId] = { start: Date.now() };
  addToTimeline(sessionId, 'ws_open');

  conn.on('error', e => {
    captureException(e, conn, sessionId, videoKey, 'WEBSOCKET ERROR');
  });

  conn.on('close', () => {
    addToTimeline(sessionId, 'ws_closed');
    delete globalState.sessions[sessionId];
  });

  conn.on('message', async _message => {
    Raven.context(async () => {
      let message;

      try {
        message = JSON.parse(_message);
        switch (message.id) {
          case 'start': {
            return start(sessionId, conn, message.sdpOffer, videoKey);
          }

          case 'stop': {
            const payload = await stop(sessionId, videoKey);
            return sendMessage({ id: 'uploadSuccess', payload }, conn);
          }

          case 'status': {
            globalState.sessions[sessionId].client = message.dump;
            return;
          }

          case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

          default:
            throw new Error(`Invalid message ${message}`);
        }
      } catch (e) {
        captureException(e, conn, sessionId, videoKey, message);
      }
    });
  });
});

// health check
if (process.env.NODE_ENV === 'production') {
  app.get('/ping', (req, res) => {
    res.send('pong');
  });
} else {
  app.get('/ping', (req, res) => {
    const state = JSON.stringify(globalState, null, 2);
    res.send(`<pre>${state}</pre>`);
  });
}

server.listen(8443);

console.log(`Orchestration Started (${process.env.NODE_ENV || 'development'})`);
