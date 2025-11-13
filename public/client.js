class Chat {
  constructor() {
    this.ws;
    this.username = `user_${crypto.getRandomValues(new Uint32Array(1))[0]}`;
    this.userInfo = {
      id: null,
      name: this.username,
    };
    this.onlineArea = document.querySelector("#onlineArea>ul");
    this.localVideo = document.querySelector("#myVideo");
    this.remoteVideoContainer = document.querySelector("#remoteVideos");

    this.localStream = null;
    this.peerConnections = {}; // { remoteUserId: pc }
    this.remoteStreams = {}; // { remoteUserId: stream }

    this.configuration = {
      iceServers: [
        {
          "urls": ["stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
            "stun:stun2.l.google.com:19302"]
        }
      ]
    };

    this._init();
  }

  _init() {
    this.connection();
    const shareBTN = document.getElementById("shareBTN");
    shareBTN.onclick = () => { this.shareScreen() };
  }

  connection() {
    const serverUrl = "wss://devinsights-myWebrtc-signaling.hf.space";
    //const serverUrl = "ws://localhost:3000";
    console.log(`[System] Connecting to WebSocket server at ${serverUrl}...`);
    this.ws = new WebSocket(serverUrl);

    this.ws.onopen = () => {
      console.log("[System] WebSocket connection established.");
      this.ws.send(JSON.stringify({ status: "connect", name: this.userInfo.name }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log("[Received Message]", data);
      this.message(data);
    };

    this.ws.onclose = () => {
      console.warn("[System] WebSocket connection closed.");
    };

    this.ws.onerror = (err) => {
      console.error("[System] WebSocket error:", err);
      alert("無法連線到伺服器");
    }
  }

  message(data) {
    switch (data.status) {
      case "connect":
        this.userInfo.id = data.id;
        this.createClient(this.userInfo, true);
        break;

      case "newClient":
        this.createClient(data);
        break;

      case "syncClient":
        console.log("[Sync] Synchronizing existing clients:", data.clients);
        data.clients.forEach((c) => {
          this.createClient(c);
        });
        break;

      case "updateClient":
        console.log(`[UI] Updating button for user ${data.id}, sharing: ${data.isShareScreen}`);
        this.updateClientButton(data.id, data.isShareScreen);
        break;

      case "request_offer":
        console.log(`[Presenter] Received offer request from ${data.fromId}. Creating offer...`);
        this.handleOfferRequest(data.fromId);
        break;

      case "offer":
        console.log(`[Viewer] Received offer from ${data.fromId}. Creating answer...`);
        this.handleOffer(data.fromId, data.offer);
        break;

      case "answer":
        console.log(`[Presenter] Received answer from ${data.fromId}.`);
        this.handleAnswer(data.fromId, data.answer);
        break;

      case "candidate":
        // console.log(`[WebRTC] Received ICE candidate from ${data.fromId}.`);
        this.handleCandidate(data.fromId, data.candidate);
        break;

      case "closeClient":
        console.log(`[System] Client ${data.id} disconnected.`);
        this.removeClient(data.id);
        break;
    }
  }

  createClient(info, isSelf = false) {
    const existing = this.onlineArea.querySelector(`[data-id="${info.id}"]`);
    if (existing) return;

    console.log(`[UI] Creating client element for ${info.name} (${info.id})`);
    const clientElement = document.createElement('li');
    clientElement.className = 'customer';
    clientElement.dataset.id = info.id;
    clientElement.innerHTML = `
      <div class="headPhoto" style="--state:greenyellow"><img src="./user.png"></div>
      <span>${info.name}${isSelf ? ' (You)' : ''}</span>
    `;
    this.onlineArea.appendChild(clientElement);
    if (info.isShareScreen) {
      this.updateClientButton(info.id, true);
    }
  }

  updateClientButton(userId, isSharing) {
    const el = this.onlineArea.querySelector(`[data-id="${userId}"]`);
    if (!el) return;

    let btn = el.querySelector("button");
    if (isSharing) {
      if (!btn) {
        btn = document.createElement("button");
        btn.textContent = "觀看";
        btn.onclick = () => {
          console.log(`[Action] Clicking 'Watch' for user ${userId}`);
          this.ws.send(JSON.stringify({ status: "join", targetId: userId }));
        };
        el.appendChild(btn);
      }
    } else {
      if (btn) {
        btn.remove();
      }
    }
  }

  async shareScreen() {
    if (this.localStream) {
      console.log("[Action] Stopping screen share.");
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
      this.localVideo.srcObject = null;
      this.ws.send(JSON.stringify({ status: "shareScreen", isShareScreen: false }));
      document.getElementById("shareBTN").textContent = "分享螢幕";
      return;
    }

    try {
      console.log("[Action] Starting screen share...");
      this.localStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: true
      });
      this.localVideo.srcObject = this.localStream;
      this.ws.send(JSON.stringify({ status: "shareScreen", isShareScreen: true }));
      document.getElementById("shareBTN").textContent = "停止分享";
      console.log("[Action] Screen share started and status sent to server.");
    } catch (error) {
      console.error("Error sharing screen:", error);
    }
  }

  async handleOfferRequest(fromId) {
    const pc = new RTCPeerConnection(this.configuration);
    this.peerConnections[fromId] = pc;
    console.log(`[Presenter] PC created for ${fromId}.`);

    this.localStream.getTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
    });
    console.log(`[Presenter] Local stream tracks added for ${fromId}.`);

    pc.onicecandidate = e => {
      if (e.candidate) {
        // console.log(`[Presenter] Sending ICE candidate to ${fromId}`);
        this.ws.send(JSON.stringify({ status: "candidate", targetId: fromId, candidate: e.candidate }));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    console.log(`[Presenter] Offer created and set as local description. Sending to ${fromId}.`);
    this.ws.send(JSON.stringify({ status: "offer", targetId: fromId, offer: pc.localDescription }));
  }

  async handleAnswer(fromId, answer) {
    const pc = this.peerConnections[fromId];
    if (pc) {
      console.log(`[Presenter] Setting remote description for ${fromId}.`);
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  async handleOffer(fromId, offer) {
    const pc = new RTCPeerConnection(this.configuration);
    this.peerConnections[fromId] = pc;
    console.log(`[Viewer] PC created for connection to ${fromId}.`);

    pc.ontrack = (event) => {
      console.log(`%c[Viewer] TRACK EVENT RECEIVED from ${fromId}!`, 'color: green; font-weight: bold;');
      this.handleRemoteStream(fromId, event.streams[0]);
    };

    pc.onicecandidate = e => {
      if (e.candidate) {
        // console.log(`[Viewer] Sending ICE candidate to ${fromId}`);
        this.ws.send(JSON.stringify({ status: "candidate", targetId: fromId, candidate: e.candidate }));
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    console.log(`[Viewer] Remote description (offer) set for ${fromId}.`);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log(`[Viewer] Answer created and set as local description. Sending to ${fromId}.`);

    this.ws.send(JSON.stringify({ status: "answer", targetId: fromId, answer: pc.localDescription }));
  }

  handleRemoteStream(fromId, stream) {
    console.log(stream)
    if (this.remoteStreams[fromId]) {
      console.log(`[Viewer] Stream from ${fromId} already exists.`);
      return;
    }
    console.log(`[Viewer] Handling remote stream from ${fromId}. Creating video element.`);
    this.remoteStreams[fromId] = stream;
    const video = document.createElement('video');
    video.className = 'remoteVideo'; // Add this class for styling
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // Add this line to solve autoplay issues
    video.dataset.id = fromId;
    this.remoteVideoContainer.appendChild(video);
  }

  async handleCandidate(fromId, candidate) {
    const pc = this.peerConnections[fromId];
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('[WebRTC] Error adding received ice candidate', e);
      }
    }
  }

  removeClient(userId) {
    console.log(`[UI] Removing all elements for user ${userId}`);
    const clientEl = this.onlineArea.querySelector(`[data-id="${userId}"]`);
    if (clientEl) {
      clientEl.remove();
    }

    const videoEl = this.remoteVideoContainer.querySelector(`[data-id="${userId}"]`);
    if (videoEl) {
      videoEl.remove();
    }

    if (this.peerConnections[userId]) {
      console.log(`[WebRTC] Closing peer connection for ${userId}`);
      this.peerConnections[userId].close();
      delete this.peerConnections[userId];
    }
    if (this.remoteStreams[userId]) {
      delete this.remoteStreams[userId];
    }
  }
}

new Chat();