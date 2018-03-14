## So you've decided to check out the webrtc-video repository?

Turn back while you still can!

No just kidding. It's perfectly safe in here. It's just a node server that communicates with the client through a totally normal, safe websocket connection. There are thousands of websocket connections like this roaming the internet and it rarely results in fatalities.

What happens, more or less, is this:

* Client makes a ws connection to our friendly server at **video.simplecontacts.com**. Theres nothing interesting at that url if you are using a hypertext transfer protocol, but if you want to check that the server is working you can check out https://video.simplecontacts.com/ping.
* When the client sends us instructions to start (via a websocket message with id of 'start'), we get fix it up with the kurento media server.
* After that god knows what happens because kurento is a black box with lackluster documentation. But the video happens. We let it do its thing until we get a 'stop' message from the client.
* That nice lil video gets uploaded to s3. When we are done uploading it, we send the client back the key for that video, so that it can be saved for later.
* That's basically it!

Here are the messages the websocket can receive:

* 'start'
* 'stop'
* 'onIceCandidate'

Here are the messages that it sends:

* 'error' (includes a message)
* 'iceCandidate' (includes a candidate)
* 'uploadSuccess' (includes a videoUrl)
* 'startResponse' (includes an sdpAnswer)

The code mostly lives in server.js. To test, run `yarn test`. To run it locally, don't run it locally. Just communicate with it at **video.simplecontacts.com**.

Other endpoints:

* get request to `/ping` returns `'pong'` (health check)
* get request to `/sessions` returns current number of active sessions (for purposes of not interfering with sessions during deploy)

This project was heavily influenced by this [tutorial](https://github.com/Kurento/kurento-tutorial-node/tree/master/kurento-hello-world).

### Running locally

1. Download and install Docker: https://www.docker.com/community-edition#/download . Install nginx with homebrew `brew install nginx`
2. Run `yarn start-kurento` (8888).
3. In a new terminal window, run `yarn start`, to run server (8443) and web client (8080).
4. In a new terminal window, run `yarn start-nginx`, to reverse proxy all our services with SSL using dummy key.
5. Open https://localhost:8088/admin to test

### Paths in Production

/api/ping -> Health check
/api/client.js -> client-side lib
/api/recorder -> Websocket path
/admin -> Secured with basic auth, shows a smoke test.
/admin/sessions -> shows all sessions currently connected.
