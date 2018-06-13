## So you've decided to check out the stream-recorder repository?

Turn back while you still can!

No just kidding. It's perfectly safe in here. It's just a node server that communicates with the client through a totally normal, safe websocket connection. There are thousands of websocket connections like this roaming the internet and it rarely results in fatalities.

### Example usage:

Starting the recorder:

```
const recorder = await Recorder(
  process.env.NODE_ENV === 'production'
    ? 'wss://video.simplecontacts.com/recorder'
    : 'wss://localhost:8088/recorder',
  'some_id',
);

div.innerHTML = 'Starting recorder...';
await recorder.start(
  stream,
  ({ videoBytesSent, networkType, destination }) => {
    const video = parseInt(videoBytesSent / 1024, 10);
    const destinationInfo = destination
      ? `to ${destination} (${networkType})`
      : '';
    bytesTransferedDiv.innerHTML = `
      Streamed <strong>${video}</strong>kb ${destinationInfo}<br />
  `;
  },
);
```

Stopping the recorder:

```
 const { size, signedUrl, debugUrl } = await recorder.stop({
   someMetaDataForS3: 'must-be-a-string'
 });
```

### Health Check

You can make sure everything is running as intended staging: https://recorder-master.stage.simplecontacts.com

### Running locally

1. Download and install Docker: https://www.docker.com/community-edition#/download . Install nginx with homebrew `brew install nginx`
2. Run `yarn start-kurento` (8888).
3. In a new terminal window, run `yarn start`, to run server (8443) and web client (8080).
4. In a new terminal window, run `yarn start-nginx`, to reverse proxy all our services with SSL using dummy key.
5. Open https://localhost:8088/admin to test
