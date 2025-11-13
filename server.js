const crypto = require("crypto");
const MyServer = require("ws");
const wss = new MyServer.Server({ port: 3000 });
let allClients = []; // Store each client

wss.on("connection", (ws) => {
  console.log("client is connected");

  ws.on("message", bufferData => {
    let data = {};
    try {
      data = JSON.parse(Buffer.from(bufferData).toString());
    } catch (e) {
      console.error("Failed to parse message", e);
      return;
    }
    
    const fromUser = allClients.find(c => c.ws === ws);
    const targetUser = data.targetId ? allClients.find(c => c.id === data.targetId) : null;

    switch (data.status) {
      case "connect":
        let user = {
          id: crypto.getRandomValues(new Uint32Array(1))[0],
          name: data.name,
          ws: ws,
          isShareScreen: false
        };
        allClients.push(user);
        ws.send(JSON.stringify({ status: "connect", id: user.id, name: user.name }));

        const otherClients = allClients.filter(c => c.ws !== ws);
        
        // Notify other clients of the new connection
        otherClients.forEach(client => {
          if (client.ws.readyState === MyServer.OPEN) {
            client.ws.send(JSON.stringify({ status: "newClient", id: user.id, name: user.name }));
          }
        });

        // Send the list of existing clients to the new client
        if (otherClients.length > 0) {
          let syncClients = otherClients.map(c => ({ id: c.id, name: c.name, isShareScreen: c.isShareScreen }));
          ws.send(JSON.stringify({ status: "syncClient", clients: syncClients }));
        }
        break;

      case "shareScreen":
        if (fromUser) {
          fromUser.isShareScreen = data.isShareScreen;
          // Broadcast the screen sharing status update to all other clients
          allClients.forEach(client => {
            if (client.ws !== ws && client.ws.readyState === MyServer.OPEN) {
              client.ws.send(JSON.stringify({ status: "updateClient", id: fromUser.id, isShareScreen: fromUser.isShareScreen }));
            }
          });
        }
        break;

      // Viewer wants to watch a stream. Forward request to presenter.
      case "join":
        if (fromUser && targetUser && targetUser.ws.readyState === MyServer.OPEN) {
          targetUser.ws.send(JSON.stringify({
            status: "request_offer",
            fromId: fromUser.id,
            fromName: fromUser.name
          }));
        }
        break;

      // Presenter sends an offer to a specific viewer.
      case "offer":
        if (fromUser && targetUser && targetUser.ws.readyState === MyServer.OPEN) {
          targetUser.ws.send(JSON.stringify({
            status: "offer",
            fromId: fromUser.id,
            offer: data.offer
          }));
        }
        break;

      // Viewer sends an answer back to the presenter.
      case "answer":
        if (fromUser && targetUser && targetUser.ws.readyState === MyServer.OPEN) {
          targetUser.ws.send(JSON.stringify({
            status: "answer",
            fromId: fromUser.id,
            answer: data.answer
          }));
        }
        break;

      // A peer (presenter or viewer) sends an ICE candidate. Forward it.
      case "candidate":
        if (fromUser && targetUser && targetUser.ws.readyState === MyServer.OPEN) {
          targetUser.ws.send(JSON.stringify({
            status: "candidate",
            fromId: fromUser.id,
            candidate: data.candidate
          }));
        }
        break;
    }
  });

  ws.on("close", () => {
    const index = allClients.findIndex(item => item.ws === ws);
    if (index !== -1) {
      const disconnectedUser = allClients[index];
      allClients.splice(index, 1);
      console.log("client disconnected, remaining:", allClients.length);
      
      // Notify all other clients
      wss.clients.forEach(client => {
        if (client.readyState === MyServer.OPEN) {
          client.send(JSON.stringify({ status: "closeClient", id: disconnectedUser.id }));
        }
      });
    }
  });
});
