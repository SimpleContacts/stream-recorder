# Stream Recorder

This project allows recording of local video in Safari on desktop and mobile devices. Other web browsers enable recording of audio and video with the [MediaStream Recording API](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream_Recording_API). Safari had no support for this API until [very recently](https://blog.addpipe.com/safari-technology-preview-73-adds-limited-mediastream-recorder-api-support/). Rather than generating a media file within this browser, the audio/video is transmitted via WebRTC to a server running Kurento Media Server and the file will be generated on the server. With the API, you can provide a postback URL for the server to post the file too.

## So you've decided to check out the stream-recorder repository?

Turn back while you still can!

No just kidding. It's perfectly safe in here. It's just a node server that communicates with the client through a totally normal, safe websocket connection. There are thousands of websocket connections like this roaming the internet and it rarely results in fatalities.

### Example usage:

Starting the recorder:

```javascript
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
    console.log(`${video}kb ${destinationInfo}`)
  `;
  },
);
```

Stopping the recorder:

```javascript
 const { size } = await recorder.stop({
   someMetaDataForS3: 'must-be-a-string'
 }, 'http://some-url-to-post-video.com');
```

### Running locally

1. Download and install Docker: https://www.docker.com/community-edition#/download . Install nginx with homebrew `brew install nginx`
2. Run `yarn start-kurento` (8888).
3. In a new terminal window, run `yarn start`, to run server (8443) and web client (8080).
4. In a new terminal window, run `yarn start-nginx`, to reverse proxy all our services with SSL using dummy key.
5. Open https://localhost:8088/admin to test
