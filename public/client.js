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
          urls: [
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
            "stun:stun2.l.google.com:19302"
          ]
        },
        // 加入 TURN 伺服器以改善非區網連線
        {
          urls: "turn:openrelay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject"
        },
        {
          urls: "turn:openrelay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject"
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

    // 監控連線狀態
    pc.onconnectionstatechange = () => {
      console.log(`[Presenter] Connection state with ${fromId}: ${pc.connectionState}`);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[Presenter] ICE connection state with ${fromId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        console.error(`[Presenter] ICE connection failed for ${fromId}`);
      }
    };

    // 添加本地串流軌道
    this.localStream.getTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
      console.log(`[Presenter] Added track: ${track.kind}, enabled: ${track.enabled}`);
    });

    // 創建 offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log(`[Presenter] Offer created and set as local description for ${fromId}.`);

    // 等待 ICE 候選收集完成
    await this.waitForIceGathering(pc, fromId, 'Presenter');

    console.log(`[Presenter] ICE gathering complete. Sending offer to ${fromId}.`);
    this.ws.send(JSON.stringify({ 
      status: "offer", 
      targetId: fromId, 
      offer: pc.localDescription 
    }));

    // ICE 候選事件處理（用於 trickle ICE）
    pc.onicecandidate = e => {
      if (e.candidate) {
        console.log(`[Presenter] Sending additional ICE candidate to ${fromId}`);
        this.ws.send(JSON.stringify({ 
          status: "candidate", 
          targetId: fromId, 
          candidate: e.candidate 
        }));
      }
    };
  }

  async handleAnswer(fromId, answer) {
    const pc = this.peerConnections[fromId];
    if (pc) {
      console.log(`[Presenter] Setting remote description (answer) for ${fromId}.`);
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log(`[Presenter] Remote description set successfully for ${fromId}.`);
    }
  }

  async handleOffer(fromId, offer) {
    const pc = new RTCPeerConnection(this.configuration);
    this.peerConnections[fromId] = pc;
    console.log(`[Viewer] PC created for connection to ${fromId}.`);

    // 監控連線狀態
    pc.onconnectionstatechange = () => {
      console.log(`[Viewer] Connection state with ${fromId}: ${pc.connectionState}`);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[Viewer] ICE connection state with ${fromId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        console.error(`[Viewer] ICE connection failed for ${fromId}`);
      }
    };

    // 接收遠端軌道
    pc.ontrack = (event) => {
      console.log(`%c[Viewer] TRACK EVENT from ${fromId}`, 'color: green; font-weight: bold;');
      console.log(`[Viewer] Track kind: ${event.track.kind}, enabled: ${event.track.enabled}, readyState: ${event.track.readyState}`);
      
      if (event.streams && event.streams[0]) {
        console.log(`[Viewer] Stream has ${event.streams[0].getTracks().length} tracks`);
        this.handleRemoteStream(fromId, event.streams[0]);
      } else {
        console.warn(`[Viewer] No streams in track event from ${fromId}`);
      }
    };

    // ICE 候選事件處理
    pc.onicecandidate = e => {
      if (e.candidate) {
        console.log(`[Viewer] Sending additional ICE candidate to ${fromId}`);
        this.ws.send(JSON.stringify({ 
          status: "candidate", 
          targetId: fromId, 
          candidate: e.candidate 
        }));
      }
    };

    // 設定遠端描述（offer）
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    console.log(`[Viewer] Remote description (offer) set for ${fromId}.`);

    // 創建 answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log(`[Viewer] Answer created and set as local description for ${fromId}.`);

    // 等待 ICE 候選收集完成
    await this.waitForIceGathering(pc, fromId, 'Viewer');

    console.log(`[Viewer] ICE gathering complete. Sending answer to ${fromId}.`);
    this.ws.send(JSON.stringify({ 
      status: "answer", 
      targetId: fromId, 
      answer: pc.localDescription 
    }));
  }

  // 等待 ICE 候選收集完成的輔助函數
  waitForIceGathering(pc, peerId, role) {
    return new Promise((resolve) => {
      // 如果已經完成,直接 resolve
      if (pc.iceGatheringState === 'complete') {
        console.log(`[${role}] ICE gathering already complete for ${peerId}`);
        resolve();
        return;
      }

      // 設定超時,避免無限等待
      const timeout = setTimeout(() => {
        console.warn(`[${role}] ICE gathering timeout for ${peerId}, proceeding anyway...`);
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }, 5000); // 5 秒超時

      const checkState = () => {
        console.log(`[${role}] ICE gathering state for ${peerId}: ${pc.iceGatheringState}`);
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          pc.removeEventListener('icegatheringstatechange', checkState);
          console.log(`[${role}] ICE gathering complete for ${peerId}`);
          resolve();
        }
      };

      pc.addEventListener('icegatheringstatechange', checkState);
    });
  }

  handleRemoteStream(fromId, stream) {
    if (this.remoteStreams[fromId]) {
      console.log(`[Viewer] Stream from ${fromId} already exists, updating...`);
      const existingVideo = this.remoteVideoContainer.querySelector(`[data-id="${fromId}"]`);
      if (existingVideo) {
        existingVideo.srcObject = stream;
      }
      return;
    }
    
    console.log(`[Viewer] Setting up remote stream from ${fromId}`);
    console.log(`[Viewer] Stream active: ${stream.active}, tracks: ${stream.getTracks().length}`);
    
    // 記錄每個軌道的狀態
    stream.getTracks().forEach(track => {
      console.log(`[Viewer] Track: ${track.kind}, enabled: ${track.enabled}, readyState: ${track.readyState}`);
      
      // 監聽軌道結束事件
      track.onended = () => {
        console.log(`[Viewer] Track ${track.kind} ended for ${fromId}`);
      };
    });

    this.remoteStreams[fromId] = stream;
    
    // 創建 video 元素
    const video = document.createElement('video');
    video.className = 'remoteVideo';
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false; // 改為 false 以聽到音訊
    video.dataset.id = fromId;
    
    // 錯誤處理
    video.onerror = (e) => {
      console.error(`[Viewer] Video error for ${fromId}:`, e);
    };
    
    // metadata 載入完成
    video.onloadedmetadata = () => {
      console.log(`[Viewer] Video metadata loaded for ${fromId}`);
      console.log(`[Viewer] Video dimensions: ${video.videoWidth}x${video.videoHeight}`);
      
      // 如果尺寸為 0,可能是軌道有問題
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        console.warn(`[Viewer] Video dimensions are 0 for ${fromId}, might indicate a problem`);
      }
    };
    
    // 開始播放
    video.onloadeddata = () => {
      console.log(`[Viewer] Video data loaded for ${fromId}, attempting to play...`);
      video.play().catch(e => {
        console.error(`[Viewer] Error playing video for ${fromId}:`, e);
      });
    };
    
    this.remoteVideoContainer.appendChild(video);
    console.log(`[Viewer] Video element added to DOM for ${fromId}`);
  }

  async handleCandidate(fromId, candidate) {
    const pc = this.peerConnections[fromId];
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`[WebRTC] Added ICE candidate from ${fromId}`);
      } catch (e) {
        console.error(`[WebRTC] Error adding ICE candidate from ${fromId}:`, e);
      }
    } else {
      if (!pc) {
        console.warn(`[WebRTC] No peer connection found for ${fromId} when adding candidate`);
      }
    }
  }

  removeClient(userId) {
    console.log(`[UI] Removing all elements for user ${userId}`);
    
    // 移除用戶列表元素
    const clientEl = this.onlineArea.querySelector(`[data-id="${userId}"]`);
    if (clientEl) {
      clientEl.remove();
    }

    // 移除影片元素
    const videoEl = this.remoteVideoContainer.querySelector(`[data-id="${userId}"]`);
    if (videoEl) {
      videoEl.remove();
    }

    // 關閉並清理 peer connection
    if (this.peerConnections[userId]) {
      console.log(`[WebRTC] Closing peer connection for ${userId}`);
      this.peerConnections[userId].close();
      delete this.peerConnections[userId];
    }
    
    // 清理遠端串流
    if (this.remoteStreams[userId]) {
      delete this.remoteStreams[userId];
    }
  }
}

new Chat();
