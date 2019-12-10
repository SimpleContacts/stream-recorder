/* eslint-disable no-console, consistent-return */

/* global WebSocket, RTCIceCandidate, RTCSessionDescription, RTCPeerConnection */

export default ({ url, userId, videoStream }) =>
  new Promise(resolveStreamer => {
    const ws = new WebSocket(url);

    const logError = console.error;

    let pc = null;
    const startTimeout = null;
    let resolveRegister = null;
    let resolveCall = null;
    let receiveCallPromise = new Promise(async _resolveCall => {
      resolveCall = _resolveCall;
    });
    const registerPromise = new Promise(r => {
      resolveRegister = r;
    });
    let resolveCallConnected = null;
    const callConnectedPromise = new Promise(async _resolveCallConnected => {
      resolveCallConnected = _resolveCallConnected;
    });
    let resolveHangup = null;
    const resolveHangupPromise = new Promise(async _resolveHangup => {
      resolveHangup = _resolveHangup;
    });
    const queuedRemoteCandidates = [];

    ws.onerror = err => {
      logError(err);
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

    function sendMessage(message) {
      const jsonMessage = JSON.stringify(message);
      ws.send(jsonMessage);
    }

    async function processAnswer(desc) {
      const answer = new RTCSessionDescription(desc);

      pc.setRemoteDescription(answer);
    }

    async function receiveCall(desc) {
      pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: ['turn:video.simplecontacts.com:3478'],
            credential: 'sc',
            username: 'opto',
          },
        ],
      });

      pc.addEventListener('track', e => {
        resolveCall(e.streams[0]);
      });

      pc.addEventListener('icecandidate', e => {
        const candidate = e.candidate;
        if (candidate) {
          sendMessage({
            relayToCaller: true,
            id: 'onIceCandidate',
            candidate,
          });
        }
      });

      pc.addEventListener('iceconnectionstatechange', () => {
        console.log(`ICE state: ${pc.iceConnectionState}`);
      });

      pc.addEventListener('signalingstatechange', () => {
        if (pc.signalingState === 'stable') {
          queuedRemoteCandidates.forEach(c => {
            pc.addIceCandidate(new RTCIceCandidate(c));
          });
        }
        console.log(pc.signalingState);
      });

      videoStream.getTracks().forEach(track => pc.addTrack(track, videoStream));

      await pc.setRemoteDescription(desc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      sendMessage({
        relayToCaller: true,
        id: 'answer',
        desc: pc.localDescription,
      });
    }

    ws.onmessage = async message => {
      const parsedMessage = JSON.parse(message.data);
      console.log(parsedMessage.id);
      try {
        switch (parsedMessage.id) {
          /** From API **/
          case 'callConnected': {
            clearTimeout(startTimeout);
            return resolveCallConnected();
          }
          /** from callee **/
          case 'answer': {
            return await processAnswer(parsedMessage.desc);
          }

          /** from caller **/
          case 'offer': {
            receiveCallPromise = receiveCall(parsedMessage.desc);
            return;
          }

          /** From callee or caller **/
          case 'hangup':
            return resolveHangup();
          case 'registerSuccess':
            return resolveRegister();
          case 'onIceCandidate':
            return onRemoteIceCandidate(parsedMessage.candidate);
          case 'error': {
            const e = new Error(parsedMessage.error);
            e.stack = parsedMessage.error;
            e.debugUrl = parsedMessage.debugUrl;
            throw e;
          }
          default:
            return logError('Unrecognized message', parsedMessage);
        }
      } catch (e) {
        logError(e);
      }
    };

    async function call(callee) {
      sendMessage({ id: 'call', name: callee });
      await callConnectedPromise;

      pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: ['turn:video.simplecontacts.com:3478'],
            credential: 'sc',
            username: 'opto',
          },
        ],
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        console.log(`ICE state: ${pc.iceConnectionState}`);
      });

      pc.addEventListener('icecandidate', e => {
        const candidate = e.candidate;
        if (candidate) {
          sendMessage({
            relayToCallee: true,
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

      pc.addEventListener('track', e => {
        resolveCall(e.streams[0]);
      });

      videoStream.getTracks().forEach(track => pc.addTrack(track, videoStream));

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });

      await pc.setLocalDescription(offer);

      sendMessage({
        relayToCallee: true,
        id: 'offer',
        desc: pc.localDescription,
      });
      const stream = await receiveCallPromise;

      return stream;
    }

    async function waitForCall() {
      const stream = await receiveCallPromise;
      return stream;
    }

    async function waitForDisconnect() {
      await resolveHangupPromise;
      pc.close();
    }

    ws.onopen = async () => {
      sendMessage({ id: 'register', name: userId });
      await registerPromise;
      resolveStreamer({ call, waitForCall, waitForDisconnect });
    };
  });
