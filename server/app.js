/* eslint-disable consistent-return */
// @flow

import express from 'express';
import { promisify } from 'util';
import fs from 'fs';
import guid from 'guid';
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

// These files are served by express in production.
if (process.env.NODE_ENV === 'production') {
  const adminJs = fs.readFileSync(ADMINJS_PATH);
  const clientJs = fs.readFileSync(CLIENTJS_PATH);
  app.get('/admin', (req, res) => {
    res.send(`<body><script src="/admin/index.js"></script></body>`);
  });
  app.get('/admin/index.js', (req, res) => res.send(adminJs));
  app.get('/api/client.js', (req, res) => res.send(clientJs));
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

async function start(sessionId, _ws, sdpOffer, videoKey) {
  const client = await getKurentoClient();

  const pipeline = await client.create('MediaPipeline');

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

  // save a pointer to the recorder for this session
  globalState.sessions[sessionId].recorder = recorder;

  if (getCandidatesQueue(sessionId)) {
    getCandidatesQueue(sessionId).forEach(candidate =>
      webRtcEndpoint.addIceCandidate(candidate),
    );
    globalState.sessions[sessionId].candidatesQueue = [];
  }

  webRtcEndpoint.on('OnIceCandidate', event => {
    const candidate = kurento.getComplexType('IceCandidate')(event.candidate);
    sendMessage(
      {
        id: 'iceCandidate',
        candidate,
      },
      _ws,
    );
  });

  const sdpAnswer = await webRtcEndpoint.processOffer(sdpOffer);
  globalState.sessions[sessionId] = {
    ...globalState.sessions[sessionId],
    pipeline,
    webRtcEndpoint,
  };

  await webRtcEndpoint.gatherCandidates();
  await client.connect(webRtcEndpoint, recorder);
  await recorder.record();

  return sdpAnswer;
}

async function stop(sessionId, videoKey) {
  const pipeline = getPipeline(sessionId);
  getRecorder(sessionId).stop();

  // the recording was saved to the machine at /var/kurento/myrecording.webm
  const filepath = path.join(RECORDINGS_PATH, videoKey);

  // cleanup
  pipeline.release();

  // Upload file
  const data = await readFile(filepath);
  const response = await upload(data, videoKey);
  await unlink(filepath); // NOTE: Order is important, only remove file if upload was successful.
  if (response.size === 0) {
    throw new Error('No frames captured');
  }
  delete globalState.sessions[sessionId];
  return response;
}

// As of Kurento Media Server 6.0, the WebRTC negotiation is done by exchanging ICE
// candidates between the WebRTC peers. To implement this protocol, the
// webRtcEndpoint receives candidates from the client in OnIceCandidate function.
// These candidates are stored in a queue when the webRtcEndpoint is not available
// yet. Then these candidates are added to the media element by calling to the
// addIceCandidate method.
function onIceCandidate(sessionId, _candidate) {
  const candidate = kurento.getComplexType('IceCandidate')(_candidate);

  if (getWebRtcEndpoint(sessionId)) {
    getWebRtcEndpoint(sessionId).addIceCandidate(candidate);
  } else {
    globalState.sessions[sessionId] = {
      ...globalState.sessions[sessionId],
      candidatesQueue: !getCandidatesQueue(sessionId)
        ? [candidate]
        : getCandidatesQueue(sessionId).concat(candidate),
    };
  }
}

/*
 * Management of WebSocket messages
 */
wss.on('connection', conn => {
  const sessionId = guid.create().value;
  const videoKey = createS3Key('webm');

  conn.on('error', () => {
    stop(sessionId, videoKey);
  });

  conn.on('close', () => {
    stop(sessionId, videoKey);
  });

  conn.on('message', async _message => {
    Raven.context(async () => {
      let message;

      try {
        message = JSON.parse(_message);
        switch (message.id) {
          case 'start': {
            const sdpAnswer = await start(
              sessionId,
              conn,
              message.sdpOffer,
              videoKey,
            );
            return sendMessage(
              {
                id: 'startResponse',
                sdpAnswer,
              },
              conn,
            );
          }

          case 'stop': {
            const videoUrl = await stop(sessionId, videoKey);
            return sendMessage({ id: 'uploadSuccess', videoUrl }, conn);
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
        console.error(e);
        // Lets not throw here, otherwise we may break other sessions who are recording.
        Raven.captureException(e, {
          extra: {
            sessionId,
            videoKey,
            message,
            globalState: JSON.parse(JSON.stringify(globalState)),
          },
        });
        delete globalState.sessions[sessionId];
        return sendMessage(
          {
            id: 'error',
            message,
            error:
              process.env.NODE_ENV === 'production'
                ? 'Server Side Error'
                : e.stack,
          },
          conn,
        );
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

console.log('Orchestration Started!');
