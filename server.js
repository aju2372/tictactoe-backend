const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function checkWin(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a,b,c] };
    }
  }
  return null;
}

// Helper to get scores mapped to the current X/O symbols for the UI
function getFormattedScores(room) {
  const px = room.players.find(p => p.symbol === 'X');
  const po = room.players.find(p => p.symbol === 'O');

  return {
    X: px ? (room.scores[px.id] || 0) : 0,
    O: po ? (room.scores[po.id] || 0) : 0
  };
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ playerName }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      players: [{ id: socket.id, name: playerName, symbol: 'X' }],
      board: Array(9).fill(null),
      current: 'X',
      scores: { [socket.id]: 0 }, 
      gameOver: false,
      lastWinner: null
    };

    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_created', { code });
  });

  socket.on('join_room', ({ code, playerName }) => {
    const upperCode = code.toUpperCase();
    const room = rooms[upperCode];

    if (!room) return socket.emit('error', { message: 'Room not found.' });
    if (room.players.length >= 2) return socket.emit('error', { message: 'Room is full.' });

    room.players.push({ id: socket.id, name: playerName, symbol: 'O' });
    room.scores[socket.id] = 0;

    socket.join(upperCode);
    socket.roomCode = upperCode;

    const p1 = room.players[0];
    const p2 = room.players[1];
    const scores = getFormattedScores(room);

    io.to(p1.id).emit('game_start', {
      symbol: p1.symbol,
      myName: p1.name,
      opponentName: p2.name,
      board: room.board,
      current: room.current,
      scores
    });

    io.to(p2.id).emit('game_start', {
      symbol: p2.symbol,
      myName: p2.name,
      opponentName: p1.name,
      board: room.board,
      current: room.current,
      scores
    });
  });

  socket.on('make_move', ({ index }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gameOver) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.symbol !== room.current) return;
    if (room.board[index]) return;

    room.board[index] = room.current;
    const result = checkWin(room.board);

    if (result) {
      room.gameOver = true;
      room.lastWinner = result.winner;

      const winnerPlayer = room.players.find(p => p.symbol === result.winner);
      if (winnerPlayer) {
        room.scores[winnerPlayer.id] = (room.scores[winnerPlayer.id] || 0) + 1;
      }

      const scores = getFormattedScores(room);
      io.to(code).emit('game_over', {
        type: 'win',
        winner: result.winner,
        line: result.line,
        scores
      });
    } else if (room.board.every(v => v)) {
      room.gameOver = true;
      room.lastWinner = null;
      io.to(code).emit('game_over', { type: 'draw', scores: getFormattedScores(room) });
    } else {
      room.current = room.current === 'X' ? 'O' : 'X';
      io.to(code).emit('game_update', {
        board: room.board,
        current: room.current,
        scores: getFormattedScores(room)
      });
    }
  });

  socket.on('request_rematch', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.players.length < 2) return;

    // Fixed Rematch Logic:
    // If there was a winner, winner gets X.
    // If it was a draw, just swap the previous symbols to keep it fair.
    const p1 = room.players[0];
    const p2 = room.players[1];

    if (room.lastWinner) {
      const winner = room.players.find(p => p.symbol === room.lastWinner);
      const loser = room.players.find(p => p.symbol !== room.lastWinner);
      winner.symbol = 'X';
      loser.symbol = 'O';
    } else {
      // Swap symbols on draw
      const p1Prev = p1.symbol;
      p1.symbol = p2.symbol;
      p2.symbol = p1Prev;
    }

    room.board = Array(9).fill(null);
    room.current = 'X';
    room.gameOver = false;
    room.lastWinner = null;

    const scores = getFormattedScores(room);

    // Send updated info to each player individually so they know their new symbol
    room.players.forEach(p => {
      const opp = room.players.find(other => other.id !== p.id);
      io.to(p.id).emit('game_reset', {
        symbol: p.symbol,
        myName: p.name,
        opponentName: opp.name,
        board: room.board,
        current: room.current,
        scores
      });
    });
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      io.to(code).emit('opponent_left');
      delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
