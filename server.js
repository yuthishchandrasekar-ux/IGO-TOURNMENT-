const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// INITIAL STATE
let players = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'players.json'));
  players = JSON.parse(raw).map(p => ({
    ...p,
    status: 'AVAILABLE',
    basePrice: 500, // default
    soldPrice: 0,
    teamId: null
  }));
} catch (e) {
  console.log("Error loading players", e);
}

// Master State
let state = {
  stage: 'SETUP', // SETUP, LIVE, RESULTS
  captains: [
    { id: 'C1', name: 'Cap 1', teamName: 'Team Alpha', purse: 200000, password: 'p1' },
    { id: 'C2', name: 'Cap 2', teamName: 'Team Beta', purse: 200000, password: 'p2' },
    { id: 'C3', name: 'Cap 3', teamName: 'Team Gamma', purse: 200000, password: 'p3' },
    { id: 'C4', name: 'Cap 4', teamName: 'Team Delta', purse: 200000, password: 'p4' }
  ],
  settings: {
    timer: 15,
    bidIncrement: 500
  },
  currentAuction: {
    currentPlayerId: null,
    currentBid: 0,
    highestBidderId: null,
    timeLeft: 0,
    timerActive: false
  },
  history: []
};

// Timer loop
setInterval(() => {
  if (state.currentAuction.timerActive && state.currentAuction.timeLeft > 0) {
    state.currentAuction.timeLeft -= 1;
    io.emit('timer_tick', state.currentAuction.timeLeft);
    if (state.currentAuction.timeLeft === 0) {
      state.currentAuction.timerActive = false;
      io.emit('timer_ended');
    }
  }
}, 1000);

io.on('connection', (socket) => {
  // Send initial state
  socket.emit('sync_state', { state, players });

  // Authentication
  socket.on('login', ({ role, teamId, password }, callback) => {
    if (role === 'admin') {
      if (password === 'admin123') return callback({ success: true, role: 'admin' });
      return callback({ success: false, message: 'Invalid admin password' });
    }
    if (role === 'captain') {
      const cap = state.captains.find(c => c.id === teamId);
      if (cap && cap.password === password) {
        return callback({ success: true, role: 'captain', teamId });
      }
      return callback({ success: false, message: 'Invalid captain password' });
    }
    callback({ success: true, role: 'spectator' });
  });

  // Admin Actions
  socket.on('admin_update_setup', (newState) => {
    state.captains = newState.captains || state.captains;
    state.settings = newState.settings || state.settings;
    if (newState.players) players = newState.players;
    io.emit('sync_state', { state, players });
  });

  socket.on('admin_start_auction', () => {
    state.stage = 'LIVE';
    io.emit('sync_state', { state, players });
  });
  
  socket.on('admin_next_player', (playerId) => {
    const p = players.find(x => x.id === playerId);
    if(p) {
        state.currentAuction = {
            currentPlayerId: playerId,
            currentBid: p.basePrice,
            highestBidderId: null,
            timeLeft: state.settings.timer,
            timerActive: false
        };
        io.emit('sync_state', { state, players });
    }
  });
  
  socket.on('admin_start_timer', () => {
    state.currentAuction.timerActive = true;
    io.emit('sync_state', { state, players });
  });

  socket.on('admin_sold', () => {
    const { currentPlayerId, highestBidderId, currentBid } = state.currentAuction;
    if (highestBidderId && currentPlayerId) {
       const p = players.find(x => x.id === currentPlayerId);
       const c = state.captains.find(x => x.id === highestBidderId);
       if (p && c) {
          p.status = 'SOLD';
          p.soldPrice = currentBid;
          p.teamId = highestBidderId;
          c.purse -= currentBid;
          
          state.history.push({ type: 'SOLD', playerId: p.id, teamId: c.id, amount: currentBid, time: Date.now() });
          
          state.currentAuction.currentPlayerId = null;
          state.currentAuction.timerActive = false;
          io.emit('sync_state', { state, players });
       }
    }
  });
  
  socket.on('admin_unsold', () => {
    const { currentPlayerId } = state.currentAuction;
    if (currentPlayerId) {
       const p = players.find(x => x.id === currentPlayerId);
       if (p) {
          p.status = 'UNSOLD';
          state.history.push({ type: 'UNSOLD', playerId: p.id, time: Date.now() });
          state.currentAuction.currentPlayerId = null;
          state.currentAuction.timerActive = false;
          io.emit('sync_state', { state, players });
       }
    }
  });

  // Captain Actions
  socket.on('captain_bid', (teamId) => {
    const cap = state.captains.find(c => c.id === teamId);
    if (!cap) return;
    
    // Calculate next bid
    let nextBid = state.currentAuction.currentBid;
    if (state.currentAuction.highestBidderId) {
        nextBid += state.settings.bidIncrement;
    }
    
    // Check purse
    if (cap.purse >= nextBid) {
        state.currentAuction.currentBid = nextBid;
        state.currentAuction.highestBidderId = teamId;
        state.currentAuction.timeLeft = state.settings.timer;
        state.currentAuction.timerActive = true;
        
        state.history.push({ type: 'BID', playerId: state.currentAuction.currentPlayerId, teamId, amount: nextBid, time: Date.now() });
        
        io.emit('sync_state', { state, players });
        io.emit('play_bid_sound', teamId);
    }
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Auction Server running on port ${PORT}`);
});
