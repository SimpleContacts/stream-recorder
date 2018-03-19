export default video => {
  try {
    let videoBytesSent = 0;
    const candidatesPairs = [];

    video.forEach(s => {
      if (s.type === 'candidate-pair') {
        candidatesPairs.push(s);
      }
      if (s.type === 'outbound-rtp') {
        videoBytesSent += s.bytesSent;
      }
    });

    let candidatePair = null;
    let remoteCandidate = null;
    let localCandidate = null;

    if (candidatesPairs.length) {
      candidatePair = candidatesPairs.reduce((acc, c) => {
        if (c.bytesSent >= acc.bytesSent) {
          return c;
        }
        return acc;
      });

      remoteCandidate = video.get(candidatePair.remoteCandidateId);
      localCandidate = video.get(candidatePair.localCandidateId);
    }

    const destination =
      remoteCandidate &&
      `${remoteCandidate.ip}:${remoteCandidate.port} ${
        remoteCandidate.protocol
      }`;

    return {
      videoBytesSent,
      remoteCandidate,
      localCandidate,
      networkType: localCandidate && localCandidate.networkType,
      destination,
    };
  } catch (e) {
    console.error(e);
  }

  return {};
};
