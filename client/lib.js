/* eslint-disable */
import { guard, mapping, string } from 'decoders';
import getDebuggingInfo from './getDebuggingInfo';

const mapToObject = map =>
  Array.from(map).reduce(
    (acc, [key, value]) => Object.assign(acc, { [key]: value }),
    {},
  );

const wait = seconds => new Promise(resolve => setTimeout(resolve, seconds));

export default (url, userId, logError = console.error) =>
  new Promise(resolveStreamer => {
    const ws = new WebSocket(url);

    let pc = null;
    let webRtcPeer = null;
    let startTimeout = null;
    let resolveStartStreaming = null;
    let rejectStartStreaming = null;
    let resolveStopStreaming = null;
    let rejectStopStreaming = null;
    const queuedRemoteCandidates = [];
    let statsInterval = null;

    // Lets fail completly if we see an error at any point in the process.
    // This ensurses subtle bugs don't get by and video is silently not recorded.
    let hasServerError = null;

    // Lets store whether the streaming started. This way we enforce it's not clicked twice.
    let isStarted = false;

    ws.onerror = err => {
      logError(err);
      hasServerError = err.stack;
    };

    async function onRemoteIceCandidate(candidate) {
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

      pc.setRemoteDescription(answer);

      // Lets make a timeout, the server should recieve something within 3 seconds.
      startTimeout = setTimeout(() => {
        const e = new Error('Media Stream never made it to the server');
        logError(e);
        hasServerError = e;
        rejectStartStreaming(e);
        clearInterval(statsInterval);
        ws.close();
        pc.close();
      }, 6000);
    }

    ws.onmessage = async message => {
      const parsedMessage = JSON.parse(message.data);
      try {
        switch (parsedMessage.id) {
          case 'startResponse': {
            return await processAnswer(parsedMessage.sdpAnswer);
          }
          case 'recordingStarted': {
            clearTimeout(startTimeout);
            return resolveStartStreaming();
          }
          case 'error': {
            const e = new Error(parsedMessage.error);
            e.stack = parsedMessage.error;
            e.debugUrl = parsedMessage.debugUrl;
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
            clearInterval(statsInterval);
            return resolveStopStreaming(parsedMessage.payload);
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
        }, 500);

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

    async function startResponse(message) {
      webRtcPeer.processAnswer(message.sdpAnswer);
    }

    async function stop(meta) {
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
          meta: meta ? mapToObject(guard(mapping(string))(meta)) : {},
        });
      });
    }

    function sendMessage(message) {
      const jsonMessage = JSON.stringify(message);
      ws.send(jsonMessage);
    }

    ws.onopen = () => resolveStreamer({ start, stop });
  });
