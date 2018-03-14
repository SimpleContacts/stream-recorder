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
import conf from '../config';

import { upload, createS3Key } from './s3';

const RECORDINGS_PATH = conf.get('recordings_path') || '/tmp/kurento';

const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);

const app = express();
const api = express.Router();
const adminApi = express.Router();
app.use('/api/', api);
app.use('/admin/api/', adminApi);

// Admin page.
app.get('/admin', (req, res) => {
  res.send(`<body><script src="/admin/index.js"></script></body>`);
});

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
 * Definition of global variables.
 */
const sessions = {};
const candidatesQueue = {};
const recorders = {};
let kurentoClient = null;

/*
 * Server startup
 */
const server = http.createServer(app);

const wss = new ws.Server({
  server,
  path: '/api/recorder',
});

/*
 * Definition of functions
 */

// In order to control the media capabilities provided by the Kurento Media
// Server, we need an instance of the KurentoClient in the Node application
// server. In order to create this instance, we need to specify to the client
// library the location of the Kurento Media Server.
async function getKurentoClient() {
  if (kurentoClient) {
    return kurentoClient;
  }
  const client = kurento('ws://localhost:8888/kurento');
  kurentoClient = client;
  return kurentoClient;
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
  recorders[sessionId] = recorder;

  if (candidatesQueue[sessionId]) {
    while (candidatesQueue[sessionId].length) {
      const candidate = candidatesQueue[sessionId].shift();
      webRtcEndpoint.addIceCandidate(candidate);
    }
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

  // Connect endpoint to recorder
  await client.connect(webRtcEndpoint, recorder);
  await recorder.record();

  const [sdpAnswer] = await Promise.all([
    webRtcEndpoint.processOffer(sdpOffer),
    webRtcEndpoint.gatherCandidates(),
  ]);

  sessions[sessionId] = {
    pipeline,
    webRtcEndpoint,
  };

  return sdpAnswer;
}

async function stop(sessionId, videoKey) {
  if (sessions[sessionId]) {
    const pipeline = sessions[sessionId].pipeline;
    recorders[sessionId].stop();

    // the recording was saved to the machine at /var/kurento/myrecording.webm
    const filepath = path.join(RECORDINGS_PATH, videoKey);

    // cleanup
    pipeline.release();
    delete sessions[sessionId];
    delete candidatesQueue[sessionId];
    delete recorders[sessionId];

    // Upload file
    const data = await readFile(filepath);
    const response = upload(data, videoKey);
    await unlink(filepath); // NOTE: Order is important, only remove file if upload was successful.
    return response;
  }

  return null;
}

// As of Kurento Media Server 6.0, the WebRTC negotiation is done by exchanging ICE
// candidates between the WebRTC peers. To implement this protocol, the
// webRtcEndpoint receives candidates from the client in OnIceCandidate function.
// These candidates are stored in a queue when the webRtcEndpoint is not available
// yet. Then these candidates are added to the media element by calling to the
// addIceCandidate method.
function onIceCandidate(sessionId, _candidate) {
  const candidate = kurento.getComplexType('IceCandidate')(_candidate);

  if (sessions[sessionId]) {
    const webRtcEndpoint = sessions[sessionId].webRtcEndpoint;
    webRtcEndpoint.addIceCandidate(candidate);
  } else {
    if (!candidatesQueue[sessionId]) {
      candidatesQueue[sessionId] = [];
    }
    candidatesQueue[sessionId].push(candidate);
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
      const message = JSON.parse(_message);

      Raven.setUserContext({
        sessionId,
        videoKey,
        message,
      });

      try {
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

          case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

          default:
            throw new Error(`Invalid message ${message}`);
        }
      } catch (e) {
        // Lets not throw here, otherwise we may break other sessions who are recording.
        Raven.captureException(e);
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
api.get('/ping', (req, res) => {
  res.send('pong');
});

// fetch number of active sessions, since re-deploying this server will mess up active sessions
adminApi.get('/sessions', (req, res) => {
  res.send(JSON.stringify(sessions));
});

server.listen(8443);

console.log('Orchestration Started!');
