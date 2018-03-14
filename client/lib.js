/* eslint-disable */
import 'webrtc-adapter';
import './kurento-utils';

const createVideoStreamer = url =>
  new Promise(resolve => {
    const ws = new WebSocket(url);

    let webRtcPeer;
    let resolveStopStreaming;

    window.onbeforeunload = function() {
      ws.close();
    };

    ws.onerror = err => {
      console.error(err);
    };

    ws.onmessage = function(message) {
      const parsedMessage = JSON.parse(message.data);

      switch (parsedMessage.id) {
        case 'startResponse':
          startResponse(parsedMessage);
          break;
        case 'error':
          onError('Error message from server: ', parsedMessage.message);
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
          onError('Unrecognized message', parsedMessage);
      }
    };

    function start() {
      return new Promise(resolve => {
        const options = {
          onicecandidate: onIceCandidate,
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
              return onError(error);
            }
            return this.generateOffer((error, offerSdp) => {
              if (error) {
                return onError(error);
              }
              const message = {
                id: 'start',
                sdpOffer: offerSdp,
              };
              return resolve(sendMessage(message));
            });
          },
        );
      });
    }

    function onIceCandidate(candidate) {
      const message = {
        id: 'onIceCandidate',
        candidate,
      };
      sendMessage(message);
    }

    function onError(error) {
      console.error('ERROR ERROR ERROR', error);
      ws.close();
      onStreamError(error);
    }

    function startResponse(message) {
      webRtcPeer.processAnswer(message.sdpAnswer);
    }

    async function stop() {
      return new Promise(resolve => {
        if (resolveStopStreaming) {
          throw new Error('Cannot stop stream twice');
        }
        resolveStopStreaming = resolve;
        if (webRtcPeer) {
          webRtcPeer.dispose();
          webRtcPeer = null;

          sendMessage({
            id: 'stop',
          });
        }
      });
    }

    function sendMessage(message) {
      const jsonMessage = JSON.stringify(message);
      ws.send(jsonMessage);
    }

    ws.onopen = () => resolve({ start, stop });
  });

export default createVideoStreamer;
