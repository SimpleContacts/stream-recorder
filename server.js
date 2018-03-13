// @flow

import express from 'express';
import fs from 'fs';
import guid from 'guid';
import http from 'http';
import kurento from 'kurento-client';
import ws from 'ws';
import path from 'path';

import { uploadS3, createS3Key } from './s3util';

const app = express();

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
  path: '/recorder',
});

/*
 * Definition of functions
 */

// In order to control the media capabilities provided by the Kurento Media
// Server, we need an instance of the KurentoClient in the Node application
// server. In order to create this instance, we need to specify to the client
// library the location of the Kurento Media Server.
function getKurentoClient(callback) {
  if (kurentoClient !== null) {
    return callback(null, kurentoClient);
  }
  return kurento('ws://localhost:8888/kurento', (error, _kurentoClient) => {
    if (error) {
      return callback(
        `Could not find media server. Exiting with error ${error}`,
      );
    }

    kurentoClient = _kurentoClient;
    return callback(null, kurentoClient);
  });
}

// Create the Media Elements and connect them. For our purposes, we need both a
// webRtcEndpoint and a recorder
function createMediaElements(pipeline, _ws, videoKey, callback) {
  const elements = [
    {
      type: 'RecorderEndpoint',
      params: { uri: `file:///tmp/kurento/${videoKey}` },
    },
    {
      type: 'WebRtcEndpoint',
    },
  ];
  pipeline.create(elements, (error, webRtcEndpoint) => {
    if (error) {
      return callback(error);
    }

    return callback(null, webRtcEndpoint);
  });
}

function connectMediaElements(webRtcEndpoint, callback) {
  webRtcEndpoint.connect(webRtcEndpoint, error => {
    if (error) {
      return callback(error);
    }
    return callback(null);
  });
}

// Util function to send message via websocket
function sendMessage(message, connection) {
  if (connection) {
    const jsonMessage = JSON.stringify(message);
    return connection.send(jsonMessage);
  }
  throw new Error('No websocket connection');
}

// Util function to send error message via websocket
function sendError(message, connection) {
  return sendMessage({ id: 'error', message }, connection);
}

function start(sessionId, _ws, sdpOffer, videoKey, callback) {
  if (!sessionId) {
    return callback('Cannot use undefined sessionId');
  }

  return getKurentoClient((error, _kurentoClient) => {
    if (error) {
      return callback(error);
    }

    return _kurentoClient.create('MediaPipeline', (pipelineError, pipeline) => {
      if (pipelineError) {
        return callback(pipelineError);
      }

      return createMediaElements(
        pipeline,
        _ws,
        videoKey,
        (elementsError, elements) => {
          if (elementsError) {
            pipeline.release();
            return callback(elementsError);
          }
          const [recorder, webRtcEndpoint] = elements;
          // save a pointer to the recorder for this session
          recorders[sessionId] = recorder;

          if (candidatesQueue[sessionId]) {
            while (candidatesQueue[sessionId].length) {
              const candidate = candidatesQueue[sessionId].shift();
              webRtcEndpoint.addIceCandidate(candidate);
            }
          }

          return connectMediaElements(webRtcEndpoint, connectError => {
            if (connectError) {
              pipeline.release();
              return callback(error);
            }

            webRtcEndpoint.on('OnIceCandidate', event => {
              const candidate = kurento.getComplexType('IceCandidate')(
                event.candidate,
              );
              sendMessage(
                {
                  id: 'iceCandidate',
                  candidate,
                },
                _ws,
              );
            });

            webRtcEndpoint.processOffer(sdpOffer, (offerError, sdpAnswer) => {
              if (offerError) {
                pipeline.release();
                return callback(offerError);
              }

              sessions[sessionId] = {
                pipeline,
                webRtcEndpoint,
              };
              return callback(null, sdpAnswer);
            });

            webRtcEndpoint.gatherCandidates(candidatesError => {
              if (candidatesError) {
                return callback(candidatesError);
              }
              return undefined;
            });

            return _kurentoClient.connect(
              webRtcEndpoint,
              recorder,
              clientConnectError => {
                if (clientConnectError) {
                  return callback(clientConnectError);
                }
                return recorder.record(recordError => {
                  if (recordError) {
                    return callback(recordError);
                  }
                  return undefined;
                });
              },
            );
          });
        },
      );
    });
  });
}

function stop(sessionId, connection, videoKey) {
  if (sessions[sessionId]) {
    const pipeline = sessions[sessionId].pipeline;
    recorders[sessionId].stop();

    // the recording was saved to the machine at /var/kurento/myrecording.webm
    const filepath = path.join('/tmp', 'kurento', videoKey);
    // read the recording
    fs.readFile(filepath, (err, data) => {
      if (err) {
        sendError(
          err.message || 'There was an error reading the video file.',
          connection,
        );
      }
      // upload the recording to s3
      uploadS3(data, videoKey)
        .then(videoUrl => {
          // inform client that s3 upload was successful, include the video key
          // for future retrieval from s3
          sendMessage(
            {
              id: 'uploadSuccess',
              videoUrl,
            },
            connection,
          );
          // delete video from filesystem now that it is saved in s3
          fs.unlinkSync(filepath);
        })
        .catch(e => {
          sendError(
            e.message || 'There was an error uploading the video.',
            connection,
          );
        });
    });
    pipeline.release();

    delete sessions[sessionId];
    delete candidatesQueue[sessionId];
    delete recorders[sessionId];
  }
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
wss.on('connection', wsConnection => {
  const sessionId = guid.create().value;
  const videoKey = createS3Key('webm');

  wsConnection.on('error', () => {
    stop(sessionId);
  });

  wsConnection.on('close', () => {
    stop(sessionId);
  });

  wsConnection.on('message', _message => {
    const message = JSON.parse(_message);

    switch (message.id) {
      case 'start':
        start(
          sessionId,
          wsConnection,
          message.sdpOffer,
          videoKey,
          (error, sdpAnswer) => {
            if (error) {
              return sendError(error, wsConnection);
            }
            return sendMessage(
              {
                id: 'startResponse',
                sdpAnswer,
              },
              wsConnection,
            );
          },
        );
        break;

      case 'stop':
        stop(sessionId, wsConnection, videoKey);
        break;

      case 'onIceCandidate':
        onIceCandidate(sessionId, message.candidate);
        break;

      default:
        sendError(`Invalid message ${message}`, wsConnection);
        break;
    }
  });
});

// health check
app.get('/ping', (req, res) => {
  res.send('pong');
});

// fetch number of active sessions, since re-deploying this server will mess up active sessions
app.get('/sessions', (req, res) => {
  res.send(Object.keys(sessions).length);
});

server.listen(8443);
