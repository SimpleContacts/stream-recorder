/* global WebSocket */
/* eslint-disable func-names */

import 'webrtc-adapter';
import './kurento-utils';

// eslint-disable-next-line no-console
export default (url, logError = console.error) =>
  new Promise(resolveStreamer => {
    const ws = new WebSocket(url);

    let webRtcPeer = null;
    let resolveStopStreaming = null;

    // Lets fail completly if we see an error at any point in the process.
    // This ensurses subtle bugs don't get by and video is silently not recorded.
    let hasServerError = null;

    // Lets store whether the streamign started. THis way we enforce its nto clicked twice.
    let isStarted = false;

    ws.onerror = err => {
      logError(err);
      hasServerError = err.stack;
    };

    ws.onmessage = message => {
      const parsedMessage = JSON.parse(message.data);
      try {
        switch (parsedMessage.id) {
          case 'startResponse':
            webRtcPeer.processAnswer(parsedMessage.sdpAnswer);
            break;
          case 'error':
            hasServerError = parsedMessage.error;
            logError(parsedMessage);
            break;
          case 'iceCandidate':
            webRtcPeer.addIceCandidate(parsedMessage.candidate);
            break;
          case 'uploadSuccess':
            if (resolveStopStreaming) {
              resolveStopStreaming(parsedMessage.videoUrl);
            }
            ws.close();
            break;
          default:
            logError('Unrecognized message', parsedMessage);
        }
      } catch (e) {
        logError(e);
        hasServerError = e;
      }
    };

    function sendMessage(message) {
      if (hasServerError) {
        throw new Error(hasServerError);
      }
      const jsonMessage = JSON.stringify(message);
      ws.send(jsonMessage);
    }

    function start() {
      return new Promise((resolve, reject) => {
        if (isStarted) {
          return reject(new Error('Cannot start twice'));
        }
        isStarted = true;
        const options = {
          onicecandidate: candidate =>
            sendMessage({
              id: 'onIceCandidate',
              candidate,
            }),
          mediaConstraints: {
            video: true,
            audio: true,
          },
          configuration: {
            iceServers: [
              {
                url: 'turn:video.simplecontacts.com:3478',
                credential: 'sc',
                username: 'opto',
              },
            ],
          },
        };

        webRtcPeer = global.kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(
          options,
          function(error) {
            if (error) {
              return reject(error);
            }
            return this.generateOffer((error2, offerSdp) => {
              if (error2) {
                return reject(error2);
              }
              const message = {
                id: 'start',
                sdpOffer: offerSdp,
              };
              return resolve(sendMessage(message));
            });
          },
        );

        return null;
      });
    }

    async function stop() {
      return new Promise((resolve, reject) => {
        if (resolveStopStreaming) {
          return reject(new Error('Cannot stop stream twice'));
        }
        resolveStopStreaming = resolve;
        if (webRtcPeer) {
          webRtcPeer.dispose();
          webRtcPeer = null;

          sendMessage({
            id: 'stop',
          });
        }
        return null;
      });
    }

    ws.onopen = () => resolveStreamer({ start, stop });
  });
