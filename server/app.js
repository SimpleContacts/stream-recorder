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
import fetch from 'node-fetch';
import conf from '../config';

/**
 * TODO Remove references to s3
 * Allow clients to provide a postUrl to keep this module decoupled and configure-less
 */
import { upload, createS3Key } from './s3';

const RECORDINGS_PATH = conf.get('recordings_path') || '/tmp/kurento';

const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);

const app = express();

const wait = seconds => new Promise(resolve => setTimeout(resolve, seconds));

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

type Pipeline = {| create: () => void, release: () => void |};
type Candidate = mixed;
type Endpoint = {| addIceCandidate: Candidate => void |};
type Recorder = {| stop: () => void, getState: () => mixed |};

type KurentoClient = {|
  connect: (Endpoint, Recorder) => Promise<void>,
  create: ('MediaPipeline') => Promise<Pipeline>,
|};

type Session = {
  // The websocket connection.
  conn: any,

  // For debugging
  timeline?: Array<string>,

  /** Related to recording **/
  start: number,
  stop?: number,
  recording?: boolean,
  incoming_AUDIO?: boolean,
  incoming_VIDEO?: boolean,
  client?: mixed, // debug information
  webRtcEndpoint?: Endpoint,
  pipeline?: Pipeline,
  recorder?: Recorder,
  candidatesQueue?: Array<Candidate>,

  /** Related to calls **/
  name?: string,
};

type Call = {
  isConnected: boolean,
  caller: string,
  callee: string,
  messageQueue: {
    caller: Array<mixed>,
    callee: Array<mixed>,
  },
};

type GlobalState = {|
  kurentoClient: ?KurentoClient,
  processId: number,
  numJobs: number,
  sessions: { [string | number]: Session },
  calls: { [string | number]: Call },
|};

/*
 * Global State
 * This can be redux or soemthing else future.
 */
const globalState: GlobalState = {
  // This indicates the session.
  processId: Date.now(),
  // This is also used to give sessionId
  numJobs: 0,
  sessions: {},
  calls: {},
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
  if (!globalState.sessions[sessionId].recorder) {
    throw new Error('No recorder');
  }
  let state = await globalState.sessions[sessionId].recorder.getState();
  while (state !== 'START') {
    if (!globalState.sessions[sessionId].recorder) {
      throw new Error('No recorder');
    }
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
      debugUrl: debug && debug.url,
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
        await client.connect(
          webRtcEndpoint,
          recorder,
        );
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

async function stop(sessionId, videoKey, meta = {}, postUrl) {
  addToTimeline(sessionId, 'server:stop');
  if (!globalState.sessions[sessionId]) {
    throw new Error('Already stopped!');
  }

  globalState.sessions[sessionId].recording = false;

  // the recording was saved to the machine at /var/kurento/myrecording.webm
  const filepath = path.join(RECORDINGS_PATH, videoKey);

  // Upload file
  const data = await readFile(filepath);

  let response;
  if (postUrl) {
    response = await fetch(postUrl, {
      method: 'PUT',
      body: data,
      headers: meta,
    });
  } else {
    // TODO eventually deprecate this.
    response = await upload(data, videoKey, meta);
  }

  // NOTE: Order is important, only remove file if upload was successful.
  await unlink(filepath);
  const debug = await cleanup(sessionId);

  if (data.length < 100) {
    throw new Error('No frames captured');
  }

  return { ...response, debugUrl: debug && debug.url };
}

// As of Kurento Media Server 6.0, the WebRTC negotiation is done by exchanging ICE
// candidates between the WebRTC peers. To implement this protocol, the
// webRtcEndpoint receives candidates from the client in OnIceCandidate function.
// These candidates are stored in a queue when the webRtcEndpoint is not available
// yet. Then these candidates are added to the media element by calling to the
// addIceCandidate method.
async function onIceCandidate(sessionId, _candidate) {
  const candidate = kurento.getComplexType('IceCandidate')(_candidate);

  const endpoint = getWebRtcEndpoint(sessionId);
  if (endpoint) {
    addToTimeline(sessionId, 'server:addCandidate');
    endpoint.addIceCandidate(candidate);
  } else {
    addToTimeline(sessionId, 'server:queueCandidate');
    globalState.sessions[sessionId].candidatesQueue = !getCandidatesQueue(
      sessionId,
    )
      ? [candidate]
      : (getCandidatesQueue(sessionId) || []).concat(candidate);
  }
}

async function connectCalls() {
  for (const key in globalState.calls) {
    const call = globalState.calls[key];

    const callerSession = Object.values(globalState.sessions).find(
      s => s.name === call.caller,
    );

    const calleeSession = Object.values(globalState.sessions).find(
      s => s.name === call.callee,
    );

    if (callerSession && calleeSession) {
      globalState.calls[key].isConnected = true;
      sendMessage({ id: 'callConnected' }, callerSession.conn);
      sendMessage({ id: 'callConnected' }, calleeSession.conn);
    }
  }
}

function getCall(caller) {
  console.log(caller, globalState.calls);
  return Object.values(globalState.calls).find(
    c => c.callee === caller || c.caller === caller,
  );
}

function getSessionFromName(name) {
  return Object.values(globalState.sessions).find(s => s.name === name);
}

async function hangup(name) {
  for (const key in globalState.calls) {
    const call = globalState.calls[key];

    if (call.caller === name) {
      // notify the other caller of the hangup.
      const session = getSessionFromName(call.callee);
      sendMessage({ id: 'hangup' }, session.conn);
      delete globalState.calls[key];
    }

    if (call.callee === name) {
      // notify the other caller of the hangup.
      const session = getSessionFromName(call.caller);
      sendMessage({ id: 'hangup' }, session.conn);
      delete globalState.calls[key];
    }
  }
}

/*
 * Management of WebSocket messages
 */
wss.on('connection', conn => {
  const sessionId = ++globalState.numJobs;
  const videoKey = createS3Key('mp4'); // <-- TODO DEPRECATE
  globalState.sessions[sessionId] = { start: Date.now(), conn };
  addToTimeline(sessionId, 'ws_open');

  conn.on('error', e => {
    captureException(e, conn, sessionId, videoKey, 'WEBSOCKET ERROR');
  });

  conn.on('close', () => {
    addToTimeline(sessionId, 'ws_closed');

    // Close any calls that session was associated with.
    const name = globalState.sessions[sessionId].name;
    if (name) {
      hangup(name);
    }

    delete globalState.sessions[sessionId];
  });

  conn.on('message', async _message => {
    Raven.context(async () => {
      let message;

      try {
        message = JSON.parse(_message);
        console.log(message.id);

        if (message.relayToCallee) {
          const myName = globalState.sessions[sessionId].name;
          const call = getCall(myName);
          const session = getSessionFromName(call.callee);
          return sendMessage(message, session.conn);
        }

        if (message.relayToCaller) {
          const myName = globalState.sessions[sessionId].name;
          const call = getCall(myName);
          const session = getSessionFromName(call.caller);
          return sendMessage(message, session.conn);
        }

        switch (message.id) {
          case 'start': {
            return start(sessionId, conn, message.sdpOffer, videoKey);
          }

          case 'stop': {
            const payload = await stop(
              sessionId,
              videoKey,
              message.meta,
              message.postUrl,
            );
            return sendMessage({ id: 'uploadSuccess', payload }, conn);
          }

          case 'register': {
            globalState.sessions[sessionId].name = message.name;
            connectCalls();
            return sendMessage({ id: 'registerSuccess' }, conn);
          }

          case 'call': {
            const caller = globalState.sessions[sessionId].name;
            const callee = message.name;

            const callAlreadyInitiated = Object.values(globalState.calls).find(
              c => c.callee === caller && c.caller === caller,
            );

            if (callAlreadyInitiated) {
              throw new Error(`${caller} is already in a call`);
            }

            globalState.calls[Date.now()] = {
              isConnected: false,
              caller,
              callee,
              messageQueue: {
                caller: [],
                callee: [],
              },
            };

            connectCalls();

            return;
          }

          case 'hangup': {
            // Close any calls that session was associated with.
            const name = globalState.sessions[sessionId].name;
            if (name) {
              hangup(name);
            }
            return;
          }

          case 'status': {
            globalState.sessions[sessionId].client = message.dump;
            return;
          }

          case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

          default:
            throw new Error(`Invalid message ${message.id}`);
        }
      } catch (e) {
        console.error(e);
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
