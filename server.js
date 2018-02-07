var path = require('path');
var express = require('express');
var ws = require('ws');
var kurento = require('kurento-client');
var fs = require('fs');
var http = require('http');
var chalk = require('chalk');
var guid = require('guid');

var app = express();

/*
 * Definition of global variables.
 */
var sessions = {};
var candidatesQueue = {};
var kurentoClient = null;

/*
 * Server startup
 */

var server = http.createServer(app);

var wss = new ws.Server({
  server: server,
  path: '/recorder',
});

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {
  var sessionId = 'me';

  console.log('Made connection with ' + sessionId);

  ws.on('error', function(error) {
    console.log('Connection ' + sessionId + chalk.bgRed(' error'));
    stop(sessionId);
  });

  ws.on('close', function() {
    console.log('Connection ' + sessionId + chalk.bgBlue(' closed'));
    stop(sessionId);
  });

  ws.on('message', function(_message) {
    var message = JSON.parse(_message);
    console.log('incoming message -->', message.id);

    switch (message.id) {
      case 'start':
        console.log(chalk.bgBlue('this is where we we would call start'));
        start(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
          if (error) {
            return ws.send(
              JSON.stringify({
                id: 'error',
                message: error,
              }),
            );
          }
          console.log('startResponse');
          ws.send(
            JSON.stringify({
              id: 'startResponse',
              sdpAnswer: sdpAnswer,
            }),
          );
        });
        break;

      case 'stop':
        console.log(chalk.bgBlue('this is where we we would call stop'));
        stop(sessionId);
        break;

      case 'onIceCandidate':
        onIceCandidate(sessionId, message.candidate);
        break;

      default:
        ws.send(
          JSON.stringify({
            id: 'error',
            message: 'Invalid message ' + message,
          }),
        );
        break;
    }
  });
});

// /*
//  * Definition of functions
//  */
//
// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
  if (kurentoClient !== null) {
    return callback(null, kurentoClient);
  }

  console.log('Trying to connect...');
  kurento('ws://localhost:8888/kurento', function(error, _kurentoClient) {
    if (error) {
      return callback(
        'Could not find media server at address' +
          'wss://localhost:8889/kurento' +
          '. Exiting with error ' +
          error,
      );
    }

    kurentoClient = _kurentoClient;
    callback(null, kurentoClient);
  });
}

function start(sessionId, ws, sdpOffer, callback) {
  console.log(chalk.blue('start: 1 starting...'));
  if (!sessionId) {
    return callback('Cannot use undefined sessionId');
  }

  getKurentoClient(function(error, kurentoClient) {
    console.log(chalk.blue('start: 2 got kurento client'));
    if (error) {
      return callback(error);
    }

    kurentoClient.create('MediaPipeline', function(error, pipeline) {
      console.log(chalk.blue('start: 3 created media pipeline'));
      if (error) {
        return callback(error);
      }

      createMediaElements(pipeline, ws, function(error, elements) {
        console.log(chalk.blue('created media elements'), error);
        const [recorder, webRtcEndpoint] = elements;

        global.recorder = recorder;

        if (error) {
          pipeline.release();
          return callback(error);
        }

        if (candidatesQueue[sessionId]) {
          while (candidatesQueue[sessionId].length) {
            var candidate = candidatesQueue[sessionId].shift();
            webRtcEndpoint.addIceCandidate(candidate);
          }
        }

        connectMediaElements(webRtcEndpoint, function(error) {
          console.log(chalk.blue('connected media elements'));
          if (error) {
            pipeline.release();
            return callback(error);
          }

          webRtcEndpoint.on('OnIceCandidate', function(event) {
            console.log(chalk.blue('on ice candidate'));
            var candidate = kurento.getComplexType('IceCandidate')(
              event.candidate,
            );
            ws.send(
              JSON.stringify({
                id: 'iceCandidate',
                candidate: candidate,
              }),
            );
          });

          webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
            console.log(chalk.blue('processing offer'));
            if (error) {
              pipeline.release();
              return callback(error);
            }

            sessions[sessionId] = {
              pipeline: pipeline,
              webRtcEndpoint: webRtcEndpoint,
            };
            return callback(null, sdpAnswer);
          });

          webRtcEndpoint.gatherCandidates(function(error) {
            console.log(chalk.blue('gathered candidates'));
            if (error) {
              return callback(error);
            }
          });

          kurentoClient.connect(webRtcEndpoint, recorder, error => {
            if (error) {
              console.log(error);
            }
            console.log(chalk.bgYellow('Connected kurento client'));
            recorder.record(error => {
              if (error) {
                console.log(error);
              }
              console.log(chalk.blue('START'));
            });
          });
        });
      });
    });
  });
}

function createMediaElements(pipeline, ws, callback) {
  const elements = [
    {
      type: 'RecorderEndpoint',
      params: { uri: `/${Date.now()}.webm` },
    },
    {
      type: 'WebRtcEndpoint',
    },
  ];
  pipeline.create(elements, function(error, webRtcEndpoint) {
    if (error) {
      return callback(error);
    }

    return callback(null, webRtcEndpoint);
  });
}

function connectMediaElements(webRtcEndpoint, callback) {
  webRtcEndpoint.connect(webRtcEndpoint, function(error) {
    if (error) {
      return callback(error);
    }
    return callback(null);
  });
}

function stop(sessionId) {
  if (sessions[sessionId]) {
    var pipeline = sessions[sessionId].pipeline;
    console.info('Stopping recording and Releasing pipeline');
    global.recorder.stop();
    pipeline.release();

    delete sessions[sessionId];
    delete candidatesQueue[sessionId];
  }
}

function onIceCandidate(sessionId, _candidate) {
  var candidate = kurento.getComplexType('IceCandidate')(_candidate);

  if (sessions[sessionId]) {
    console.info(`Sending candidate for ${sessionId}`);
    var webRtcEndpoint = sessions[sessionId].webRtcEndpoint;
    webRtcEndpoint.addIceCandidate(candidate);
  } else {
    console.info(`Queueing candidate for ${sessionId}`);
    if (!candidatesQueue[sessionId]) {
      candidatesQueue[sessionId] = [];
    }
    candidatesQueue[sessionId].push(candidate);
  }
}
app.get('/ping', function(req, res) {
  res.send('pong');
});

server.listen(8443, function() {
  'listening on port 8443';
});
