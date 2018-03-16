/* eslint-disable */
import getDebuggingInfo from './getDebuggingInfo';

export default (url, userId, logError = console.error) =>
  new Promise(resolveStreamer => {
    const ws = new WebSocket(url);

    let pc = null;
    let webRtcPeer = null;
    let resolveStartStreaming = null;
    let rejectStartStreaming = null;
    let resolveStopStreaming = null;
    let rejectStopStreaming = null;
    const queuedRemoteCandidates = [];
    let statsInterval = null;

    // Lets fail completly if we see an error at any point in the process.
    // This ensurses subtle bugs don't get by and video is silently not recorded.
    let hasServerError = null;

    // Lets store whether the streamign started. THis way we enforce its nto clicked twice.
    let isStarted = false;

    ws.onerror = err => {
      logError(err);
      hasServerError = err.stack;
    };

    function onRemoteIceCandidate(candidate) {
      switch (pc.signalingState) {
        case 'closed':
          throw new Error('PeerConnection object is closed');
        case 'stable':
          return pc.addIceCandidate(new RTCIceCandidate(candidate));
        default:
          return queuedRemoteCandidates.push(candidate);
      }
    }

    async function processAnswer(sdp) {
      const answer = new RTCSessionDescription({
        type: 'answer',
        sdp,
      });

      return pc.setRemoteDescription(answer);
    }

    ws.onmessage = async message => {
      const parsedMessage = JSON.parse(message.data);
      try {
        switch (parsedMessage.id) {
          case 'startResponse': {
            await processAnswer(parsedMessage.sdpAnswer);
            return resolveStartStreaming();
          }
          case 'error': {
            const e = new Error(parsedMessage.error);
            e.stack = parsedMessage.error;
            if (rejectStartStreaming) {
              rejectStartStreaming(e);
            }
            if (rejectStopStreaming) {
              rejectStopStreaming(e);
            }
            throw e;
          }
          case 'iceCandidate':
            return onRemoteIceCandidate(parsedMessage.candidate);
          case 'uploadSuccess':
            ws.close();
            return resolveStopStreaming(parsedMessage.videoUrl);
          default:
            return logError('Unrecognized message', parsedMessage);
        }
      } catch (e) {
        logError(e);
        hasServerError = e;
      }
    };

    async function start(videoStream, onStats) {
      return new Promise(async (resolve, reject) => {
        resolveStartStreaming = resolve;
        rejectStartStreaming = reject;

        pc = new RTCPeerConnection({
          iceServers: [
            {
              url: 'turn:video.simplecontacts.com:3478',
              credential: 'sc',
              username: 'opto',
            },
          ],
        });

        pc.addEventListener('icecandidate', e => {
          const candidate = e.candidate;
          if (candidate) {
            sendMessage({
              id: 'onIceCandidate',
              candidate,
            });
          }
        });

        pc.addEventListener('signalingstatechange', () => {
          if (pc.signalingState === 'stable') {
            queuedRemoteCandidates.forEach(c => {
              pc.addIceCandidate(new RTCIceCandidate(c));
            });
          }
        });

        // We need both audio and video tracks for the encoding to work for
        // some weird reason. Otherwise we get 0 bytes.
        pc.addTrack(videoStream.getVideoTracks()[0]);
        pc.addTrack(videoStream.getAudioTracks()[0]);

        // Lets pump our status to our orchestration server
        statsInterval = setInterval(async () => {
          const stats = await pc.getStats(videoStream.getVideoTracks()[0]);
          const dump = Object.assign(getDebuggingInfo(stats), {
            iceConnectionState: pc.iceConnectionState,
            userId,
          });
          if (onStats) {
            onStats(dump);
          }

          sendMessage({
            id: 'status',
            dump,
          });
        }, 250);

        const offer = await pc.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false,
        });

        await pc.setLocalDescription(offer);

        return sendMessage({
          id: 'start',
          sdpOffer: pc.localDescription.sdp,
        });
      });
    }

    function onIceCandidate(candidate) {
      const message = {
        id: 'onIceCandidate',
        candidate,
      };
      sendMessage(message);
    }

    function startResponse(message) {
      webRtcPeer.processAnswer(message.sdpAnswer);
    }

    async function stop() {
      return new Promise((resolve, reject) => {
        clearInterval(statsInterval);
        if (resolveStopStreaming) {
          return reject(new Error('Cannot stop stream twice'));
        }
        resolveStopStreaming = resolve;
        rejectStopStreaming = reject;

        pc.close();

        return sendMessage({
          id: 'stop',
        });
      });
    }

    function sendMessage(message) {
      const jsonMessage = JSON.stringify(message);
      ws.send(jsonMessage);
    }

    ws.onopen = () => resolveStreamer({ start, stop });
  });
